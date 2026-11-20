/**
 * Tollgate provider: an HTTP API that charges per call through ML-DSA-87 payment-channel vouchers.
 *
 *  - Request header  `x-tollgate-voucher: <channelId>.<cumulativeWei>.<base64 ML-DSA-87 signature>`
 *  - Without a valid voucher the API answers 402 with its price and escrow.
 *  - Every paid response carries `x-tollgate-receipt`: the provider's ML-DSA-87 signature binding
 *    (channel, cumulative, sha256(body)), i.e. authenticated messaging the agent can verify.
 *  - Settlement: `claimLatest()` submits the highest voucher on chain (one tx for any number of calls).
 *
 * The paid endpoint is a small "Q-Day readiness oracle": GET /v1/pq-status?address=0x… returns the
 * account's ML-DSA-87 key status straight from the pqcKeyStatus precompile.
 */
import { mldsa87 } from "@qorechain/pqc";
import type { UnifiedAccount } from "@qorechain/sdk";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { getAddress, hexToBytes, keccak256, type Address, type Hex } from "viem";
import { FEES, NET, pqcKeyOf, publicClient, walletFor } from "./chain.ts";
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
}

export class TollgateProvider {
  readonly address: Address;
  private server?: Server;
  private channels = new Map<string, { info: ChannelInfo; voucherKey: Uint8Array }>();
  private latest = new Map<string, { cumulative: bigint; sig: Uint8Array }>();
  private cache = new Map<string, { at: number; body: unknown }>();
  stats = { paidCalls: 0, rejected: 0 };

  constructor(private readonly opts: ProviderOptions) {
    this.address = getAddress(opts.account.evm);
  }

  latestVoucher(channelId: bigint) {
    return this.latest.get(channelId.toString());
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
    this.server?.close();
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

  private async channel(id: bigint) {
    const key = id.toString();
    const known = this.channels.get(key);
    if (known) return known;
    const info = (await publicClient.readContract({ address: this.opts.escrow, abi: escrowAbi, functionName: "channel", args: [id] })) as ChannelInfo;
    const st = await pqcKeyOf(info.voucherSigner);
    if (!st.registered || !st.possessionProven || keccak256(st.pubkey) !== info.keyHash) throw new Error("voucher key mismatch");
    const entry = { info, voucherKey: hexToBytes(st.pubkey) };
    this.channels.set(key, entry);
    return entry;
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
    let ch;
    try {
      ch = await this.channel(channelId);
    } catch (e) {
      return this.paymentRequired(`unknown or invalid channel: ${(e as Error).message}`);
    }
    if (ch.info.closed || ch.info.exitAt !== 0n) return this.paymentRequired("channel closed or exiting");
    if (getAddress(ch.info.provider) !== this.address) return this.paymentRequired("channel is for another provider");
    const prev = this.latest.get(channelId.toString())?.cumulative ?? ch.info.paid;
    if (cumulative < prev + this.opts.priceWei) return this.paymentRequired(`voucher must cover at least ${prev + this.opts.priceWei} wei`);
    if (cumulative > ch.info.deposit) return this.paymentRequired("voucher exceeds deposit; top up");
    const sig = Uint8Array.from(Buffer.from(sigB64 ?? "", "base64"));
    const msg = qoreSignBytes(voucherText({ chainId: NET.evmChainId, escrow: this.opts.escrow, channelId, provider: this.address, cumulativeWei: cumulative }));
    if (!mldsa87.verify(ch.voucherKey, msg, sig)) return this.paymentRequired("bad voucher signature");
    this.latest.set(channelId.toString(), { cumulative, sig });
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

  /** Settle the highest voucher seen for `channelId` (provider's EVM tx; needs a window that admits the escrow). */
  async claimLatest(channelId: bigint): Promise<{ hash: Hex; gasEstimate: bigint } | undefined> {
    const v = this.latest.get(channelId.toString());
    if (!v) return undefined;
    const args = [channelId, v.cumulative, `0x${Buffer.from(v.sig).toString("hex")}` as Hex] as const;
    const gasEstimate = await publicClient.estimateContractGas({ account: this.address, address: this.opts.escrow, abi: escrowAbi, functionName: "claim", args });
    const hash = await walletFor(this.opts.account).writeContract({ address: this.opts.escrow, abi: escrowAbi, functionName: "claim", args, gas: (gasEstimate * 13n) / 10n, ...FEES });
    const r = await publicClient.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`claim reverted: ${hash}`);
    return { hash, gasEstimate };
  }
}
