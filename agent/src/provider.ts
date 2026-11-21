/**
 * Tollgate provider: an HTTP API that charges per call through ML-DSA-87 payment-channel vouchers.
 *
 *  - Request header  `x-tollgate-voucher: <channelId>.<cumulativeWei>.<base64 ML-DSA-87 signature>`
 *  - Without a valid voucher the API answers 402 with its price and escrow.
 *  - Every paid response carries `x-tollgate-receipt` (the provider's ML-DSA-87 signature binding channel,
 *    cumulative and sha256(body)) and `x-tollgate-cumulative` (the voucher amount it consumed).
 *  - Vouchers are verified against the key PINNED at open (its hash is stored in the channel). The provider
 *    caches that key from its first verification and persists it next to the vouchers, so a payer rotating the
 *    voucher account's key afterwards cannot void earned vouchers.
 *  - Channel state is re-read at most every 2 s (and on demand), exits are watched and auto-claimed; requests
 *    for the same channel are serialised; the latest voucher is persisted to disk before answering.
 *  - `watchExits()` claims automatically as soon as a payer starts an exit on one of our channels.
 *
 * Demo endpoint: GET /v1/pq-status?address=0x… (a Q-Day readiness oracle backed by the pqcKeyStatus precompile).
 */
import { mldsa87 } from "@qorechain/pqc";
import type { UnifiedAccount } from "@qorechain/sdk";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { getAddress, hexToBytes, keccak256, toHex, type Address, type Hex } from "viem";
import { evmWindowCost, evmWindowStatus } from "@qorechain/evm";
import { FEES, NET, openScopedWindow, pqcKeyOf, publicClient, sleep, walletFor } from "./chain.ts";
import { escrowAbi } from "./escrow.ts";
import { qoreSignBytes, receiptText, voucherText } from "./texts.ts";

interface ChannelInfo {
  payer: Address;
  provider: Address;
  voucherSigner: Address;
  keyHash: Hex;
  deposit: bigint;
  paid: bigint;
  exitAt: bigint;
  closed: boolean;
}

export interface ProviderOptions {
  account: UnifiedAccount; // the provider's PQ account (signs receipts, receives payments)
  escrow: Address;
  priceWei: bigint;
  port?: number;
  /** Where to persist the latest voucher per channel (survives restarts). */
  vouchersPath?: string;
  /** Max age of cached channel state (deposit, exit, close). Exits are also caught by watchExits(). Default 2 s. */
  refreshMs?: number;
}

type Voucher = { cumulative: bigint; sig: Uint8Array };

export class TollgateProvider {
  readonly address: Address;
  private server?: Server;
  private keys = new Map<string, Uint8Array>(); // channel -> pinned voucher key
  private latest = new Map<string, Voucher>();
  private state = new Map<string, { at: number; info: ChannelInfo }>(); // channel state, refreshed every refreshMs
  private locks = new Map<string, Promise<unknown>>();
  private cache = new Map<string, { at: number; body: unknown }>();
  private unwatch?: () => void;
  private retryAt = new Map<string, number>(); // channel -> earliest next auto-claim attempt (back-off after errors)
  /** Persisted entries that belong to other escrows: kept untouched so a redeploy never loses earned vouchers. */
  private foreign: Record<string, { cumulative: string; sig: string; key?: string }> = {};
  stats = { paidCalls: 0, rejected: 0, autoClaims: [] as Hex[] };

  constructor(private readonly opts: ProviderOptions) {
    this.address = getAddress(opts.account.evm);
    if (opts.vouchersPath && existsSync(opts.vouchersPath)) {
      // Entries are keyed "<escrow>:<channelId>" so vouchers of different escrows never mix. Legacy files keyed
      // by channel id only were written for a single escrow and are read as this one's.
      const saved = JSON.parse(readFileSync(opts.vouchersPath, "utf8")) as Record<string, { cumulative: string; sig: string; key?: string }>;
      const mine = opts.escrow.toLowerCase();
      for (const [k, v] of Object.entries(saved)) {
        const [escrow, id] = k.includes(":") ? k.split(":") : [mine, k];
        if (escrow.toLowerCase() !== mine) {
          this.foreign[k] = v;
          continue;
        }
        this.latest.set(id, { cumulative: BigInt(v.cumulative), sig: Uint8Array.from(Buffer.from(v.sig, "base64")) });
        if (v.key) this.keys.set(id, Uint8Array.from(Buffer.from(v.key, "base64")));
      }
    }
  }

  latestVoucher(channelId: bigint) {
    return this.latest.get(channelId.toString());
  }

  private persist() {
    if (!this.opts.vouchersPath) return;
    const out: Record<string, { cumulative: string; sig: string; key?: string }> = { ...this.foreign };
    const mine = this.opts.escrow.toLowerCase();
    for (const [k, v] of this.latest) {
      const key = this.keys.get(k);
      out[`${mine}:${k}`] = { cumulative: v.cumulative.toString(), sig: Buffer.from(v.sig).toString("base64"), ...(key ? { key: Buffer.from(key).toString("base64") } : {}) };
    }
    // Atomic replace: a crash mid-write must never leave a truncated file (that would lose every voucher).
    const tmp = `${this.opts.vouchersPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(out));
    renameSync(tmp, this.opts.vouchersPath);
  }

  async listen(): Promise<number> {
    const port = this.opts.port ?? 8787;
    this.server = createServer((req, res) => {
      this.handle(req.url ?? "/", req.headers["x-tollgate-voucher"] as string | undefined)
        .then(({ status, body, headers }) => {
          res.writeHead(status, { "content-type": "application/json", ...headers });
          res.end(body);
        })
        .catch((e) => {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: String(e?.message ?? e) }));
        });
    });
    await new Promise<void>((r) => this.server!.listen(port, "127.0.0.1", r));
    return port;
  }

  close() {
    this.unwatch?.();
    this.server?.close();
  }

  /**
   * Claim automatically when a payer starts an exit on a channel we hold unsettled vouchers for.
   * Polls CHANNEL STATE, not events: exits started through x/abstractaccount MsgExecuteEVM emit logs that
   * eth_getLogs does not index on QoreChain today (found in our first live run, where an event watcher missed it).
   */
  watchExits(pollMs = 3000) {
    let busy = false;
    const timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        for (const [k, v] of this.latest) {
          // One failing channel (unknown id, RPC error, reverted claim) must not stop the others being watched.
          if ((this.retryAt.get(k) ?? 0) > Date.now()) continue;
          try {
            const id = BigInt(k);
            const info = await this.channelState(id, true);
            if (info.closed || info.exitAt === 0n || v.cumulative <= info.paid) continue;
            const r = await this.withLock(k, () => this.claimLatest(id));
            if (r) this.stats.autoClaims.push(r.hash);
          } catch (e) {
            this.retryAt.set(k, Date.now() + 30_000); // back off; the challenge period is minutes to days
            console.error(`exit watcher (channel ${k}):`, (e as Error).message.split("\n")[0]);
          }
        }
      } finally {
        busy = false;
      }
    }, pollMs);
    this.unwatch = () => clearInterval(timer);
  }

  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(key, next.catch(() => undefined));
    return next;
  }

  private paymentRequired(reason: string) {
    this.stats.rejected++;
    return {
      status: 402,
      headers: {},
      body: JSON.stringify({
        error: "payment required",
        reason,
        price_wei: this.opts.priceWei.toString(),
        escrow: this.opts.escrow,
        provider: this.address,
        chain: NET.evmChainId,
        voucher_header: "x-tollgate-voucher: <channelId>.<cumulativeWei>.<base64 ML-DSA-87 sig over QoreSign(voucherText)>",
      }),
    };
  }

  /** Channel state, re-read from chain when older than refreshMs (top-ups, exits and closes are seen within that). */
  private async channelState(id: bigint, force = false): Promise<ChannelInfo> {
    const k = id.toString();
    const hit = this.state.get(k);
    if (!force && hit && Date.now() - hit.at < (this.opts.refreshMs ?? 2000)) return hit.info;
    const info = (await publicClient.readContract({ address: this.opts.escrow, abi: escrowAbi, functionName: "channel", args: [id] })) as ChannelInfo;
    this.state.set(k, { at: Date.now(), info });
    return info;
  }

  /** The voucher key pinned at open, from the ChannelOpened event (checked against the stored hash). */
  private async pinnedKey(id: bigint, info: ChannelInfo): Promise<Uint8Array> {
    const k = id.toString();
    const known = this.keys.get(k);
    if (known && keccak256(toHex(known)) === info.keyHash) return known; // re-checked: a stale cache never decides
    this.keys.delete(k);
    // Fast path: the voucher account's current registry key, if it is still the pinned one.
    const st = await pqcKeyOf(info.voucherSigner);
    let key: Hex | undefined = st.registered && keccak256(st.pubkey) === info.keyHash ? st.pubkey : undefined;
    // Rotated or deregistered since open: recover the pinned key from the ChannelOpened event (bounded chunks).
    // Note: logs emitted inside x/abstractaccount MsgExecuteEVM are not indexed by eth_getLogs today, which is why
    // the provider caches and persists the pinned key from the FIRST voucher it verifies (see persist()).
    if (!key) {
      const head = await publicClient.getBlockNumber();
      for (let to = head, i = 0; i < 30 && !key; i++, to -= 10_000n) {
        const from = to > 9_999n ? to - 9_999n : 0n;
        const logs = await publicClient.getContractEvents({ address: this.opts.escrow, abi: escrowAbi, eventName: "ChannelOpened", args: { id }, fromBlock: from, toBlock: to });
        key = (logs[0] as unknown as { args: { voucherKey: Hex } } | undefined)?.args.voucherKey;
        if (from === 0n) break;
      }
    }
    if (!key || keccak256(key) !== info.keyHash) throw new Error("pinned voucher key not found");
    const bytes = hexToBytes(key);
    this.keys.set(k, bytes);
    return bytes;
  }

  private async handle(url: string, voucher?: string) {
    const u = new URL(url, "http://localhost");
    if (u.pathname === "/health") return { status: 200, headers: {}, body: JSON.stringify({ ok: true, provider: this.address, price_wei: this.opts.priceWei.toString() }) };
    if (u.pathname !== "/v1/pq-status") return { status: 404, headers: {}, body: JSON.stringify({ error: "not found" }) };

    // ---- payment
    if (!voucher) return this.paymentRequired("missing voucher");
    const [idStr, cumStr, sigB64] = voucher.split(".");
    let channelId: bigint, cumulative: bigint;
    try {
      channelId = BigInt(idStr);
      cumulative = BigInt(cumStr);
    } catch {
      return this.paymentRequired("malformed voucher");
    }
    const sig = Uint8Array.from(Buffer.from(sigB64 ?? "", "base64"));
    const accepted = await this.withLock(channelId.toString(), async () => {
      let info: ChannelInfo;
      try {
        info = await this.channelState(channelId);
      } catch {
        return "unknown channel";
      }
      if (info.closed || info.exitAt !== 0n) return "channel closed or exiting";
      if (getAddress(info.provider) !== this.address) return "channel is for another provider";
      const prev = this.latest.get(channelId.toString())?.cumulative ?? info.paid;
      const floor = prev > info.paid ? prev : info.paid;
      if (cumulative < floor + this.opts.priceWei) return `voucher must cover at least ${floor + this.opts.priceWei} wei`;
      if (cumulative > info.deposit) {
        info = await this.channelState(channelId, true); // maybe topped up since the last refresh
        if (cumulative > info.deposit) return "voucher exceeds deposit; top up";
      }
      let key: Uint8Array;
      try {
        key = await this.pinnedKey(channelId, info);
      } catch (e) {
        return (e as Error).message;
      }
      const msg = qoreSignBytes(voucherText({ chainId: NET.evmChainId, escrow: this.opts.escrow, channelId, provider: this.address, cumulativeWei: cumulative }));
      if (!mldsa87.verify(key, msg, sig)) return "bad voucher signature";
      this.latest.set(channelId.toString(), { cumulative, sig });
      this.persist(); // durable before we answer
      return true;
    });
    if (accepted !== true) return this.paymentRequired(accepted);
    this.stats.paidCalls++;

    // ---- the paid work: a Q-Day readiness lookup (cached 60 s)
    const target = u.searchParams.get("address") ?? "";
    let body: unknown;
    const hit = this.cache.get(target);
    if (hit && Date.now() - hit.at < 60_000) body = hit.body;
    else {
      try {
        const st = await pqcKeyOf(getAddress(target));
        body = {
          address: getAddress(target),
          mldsa87_registered: st.registered && st.algorithm === 1,
          possession_proven: st.possessionProven,
          q_day_ready: st.registered && st.algorithm === 1 && st.possessionProven,
          checked_at: new Date().toISOString(),
        };
      } catch {
        body = { error: "invalid address" };
      }
      this.cache.set(target, { at: Date.now(), body });
    }
    const bodyStr = JSON.stringify(body);
    const bodySha256 = createHash("sha256").update(bodyStr).digest("hex");
    const receipt = mldsa87.sign(this.opts.account.pqc.secretKey, qoreSignBytes(receiptText({ provider: this.address, channelId, cumulativeWei: cumulative, bodySha256 })));
    return { status: 200, headers: { "x-tollgate-receipt": Buffer.from(receipt).toString("base64"), "x-tollgate-cumulative": cumulative.toString() }, body: bodyStr };
  }

  /**
   * Make sure the provider's EVM window admits one more claim; if not, open a window scoped to the escrow
   * (one hybrid-signed native tx). Found live: an auto-claim failed because the previous scoped window was used up.
   */
  private async ensureWindow() {
    const perTx = evmWindowCost({ gas: 1_000_000n, maxFeePerGas: FEES.maxFeePerGas });
    const w = await evmWindowStatus({ rest: NET.rest, address: this.opts.account.cosmos }).catch(() => undefined);
    const scopedToEscrow = !!w && w.allowedTargets.map((t) => t.toLowerCase()).includes(this.opts.escrow.toLowerCase());
    if (w?.live && w.remainingTxs > 0n && w.remainingBlocks > 10n && w.remainingValue >= perTx && (scopedToEscrow || w.allowedTargets.length === 0)) return;
    await openScopedWindow(this.opts.account, { blocks: 600n, maxTxs: 3n, maxValueUqor: perTx * 3n, allowedTargets: [this.opts.escrow] });
    await sleep(6000); // next block
  }

  /** Settle the highest voucher for `channelId` (provider's EVM tx; opens a scoped window first if needed). */
  async claimLatest(channelId: bigint): Promise<{ hash: Hex; gasEstimate: bigint; cumulative: bigint } | undefined> {
    const v = this.latest.get(channelId.toString());
    if (!v) return undefined;
    const info = (await publicClient.readContract({ address: this.opts.escrow, abi: escrowAbi, functionName: "channel", args: [channelId] })) as ChannelInfo;
    if (info.closed || v.cumulative <= info.paid) return undefined; // nothing new to settle
    const key = await this.pinnedKey(channelId, info);
    const args = [channelId, v.cumulative, toHex(key), toHex(v.sig)] as const;
    const gasEstimate = await publicClient.estimateContractGas({ account: this.address, address: this.opts.escrow, abi: escrowAbi, functionName: "claim", args });
    await this.ensureWindow();
    const hash = await walletFor(this.opts.account).writeContract({ address: this.opts.escrow, abi: escrowAbi, functionName: "claim", args, gas: (gasEstimate * 13n) / 10n, ...FEES });
    const r = await publicClient.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`claim reverted: ${hash}`);
    return { hash, gasEstimate, cumulative: v.cumulative };
  }
}
