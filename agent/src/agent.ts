/**
 * Tollgate agent client.
 *
 * The agent holds TWO keys, never the owner's:
 *  1. an ed25519 key LINKED to the owner's account (x/abstractaccount authenticator). Spends only through
 *     MsgExecuteEVM, bounded on chain by the owner's spending rule (per-tx / daily limits, allowed calls =
 *     the escrow's open / topUp / startExit / finalizeExit). A relayer submits and pays fees.
 *  2. its own ML-DSA-87 voucher key (a registered, possession-proven account the OWNER approved for the
 *     provider) that signs cumulative vouchers.
 *
 * `fetch()` pays per call with an ever-increasing voucher. It only counts a call as paid when the provider
 * confirms it consumed that voucher (`x-tollgate-cumulative`), and reports whether the provider's ML-DSA-87
 * receipt over the response verified.
 */
import { ed25519 } from "@noble/curves/ed25519";
import { mldsa87 } from "@qorechain/pqc";
import {
  buildPhantomExecuteEvm,
  decodeAuthenticatorExecutions,
  fetchAuthNonce,
  resolveEvmAuthDigestVersion,
  type AuthenticatorExecutionResult,
  type UnifiedAccount,
} from "@qorechain/sdk";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { encodeFunctionData, getAddress, hexToBytes, type Address, type Hex } from "viem";
import { NET, broadcastNative, pqcKeyOf, publicClient } from "./chain.ts";
import { escrowAbi } from "./escrow.ts";
import { qoreSignBytes, receiptText, voucherText } from "./texts.ts";

export interface AgentOptions {
  escrow: Address;
  owner: { cosmos: string; evm: Address }; // the account the linked key spends from (public addresses only)
  ed25519PrivateKey: Hex; // the linked authenticator key
  voucher: UnifiedAccount; // the agent's ML-DSA-87 voucher account
  relayer: UnifiedAccount; // submits MsgExecuteEVM and pays fees
  /** Optional file that persists cumulative voucher amounts, so a restart never signs a lower total. */
  statePath?: string;
}

export interface ExecOutcome {
  txHash: string;
  height: number;
  result: AuthenticatorExecutionResult;
}

export class TollgateAgent {
  readonly edPub: Uint8Array;
  private cumulative = new Map<string, bigint>();
  private providerKeys = new Map<string, Uint8Array>();

  constructor(private readonly o: AgentOptions) {
    this.edPub = ed25519.getPublicKey(hexToBytes(o.ed25519PrivateKey));
    if (o.statePath && existsSync(o.statePath)) {
      for (const [k, v] of Object.entries(JSON.parse(readFileSync(o.statePath, "utf8")) as Record<string, string>)) this.cumulative.set(k, BigInt(v));
    }
  }

  private key(channelId: bigint) {
    return `${this.o.escrow.toLowerCase()}:${channelId}`;
  }

  private persist() {
    if (!this.o.statePath) return;
    writeFileSync(this.o.statePath, JSON.stringify(Object.fromEntries([...this.cumulative].map(([k, v]) => [k, v.toString()])), null, 2));
  }

  get voucherSigner(): Address {
    return getAddress(this.o.voucher.evm);
  }

  /** Execute an EVM call AS the owner's account through the linked ed25519 key (MsgExecuteEVM via the relayer). */
  async execute(to: Address, data: Hex, valueWei = 0n, gasLimit = 600_000n): Promise<ExecOutcome> {
    const sk = hexToBytes(this.o.ed25519PrivateKey);
    const wallet = { publicKey: this.edPub, signMessage: async (m: Uint8Array) => ed25519.sign(m, sk) };
    const [{ nonce }, digestVersion] = await Promise.all([
      fetchAuthNonce({ rest: NET.rest, address: this.o.owner.cosmos, pubkey: this.edPub }),
      resolveEvmAuthDigestVersion({ rest: NET.rest }),
    ]);
    const msg = await buildPhantomExecuteEvm({
      wallet,
      relayer: this.o.relayer.cosmos,
      chainId: NET.chainId,
      account: this.o.owner.cosmos,
      to,
      value: valueWei.toString(),
      data: hexToBytes(data),
      gasLimit,
      nonce,
      digestVersion,
    });
    const res = await broadcastNative(this.o.relayer, "hybrid", [msg], { gas: Number(gasLimit) + 900_000 });
    const [result] = decodeAuthenticatorExecutions(res as never, [msg]);
    return { txHash: res.transactionHash, height: Number((res as { height: number }).height), result };
  }

  /**
   * Open a channel to an owner-approved provider. The id is read from the escrow's `lastChannel` view:
   * logs emitted inside MsgExecuteEVM are not indexed by eth_getLogs on QoreChain today.
   */
  async openChannel(provider: Address, depositWei: bigint): Promise<ExecOutcome & { channelId?: bigint }> {
    const data = encodeFunctionData({ abi: escrowAbi, functionName: "open", args: [provider] });
    const out = await this.execute(this.o.escrow, data, depositWei);
    let channelId: bigint | undefined;
    if (out.result.success) {
      const [exists, id] = (await publicClient.readContract({
        address: this.o.escrow,
        abi: escrowAbi,
        functionName: "lastChannel",
        args: [this.o.owner.evm, provider],
      })) as [boolean, bigint];
      if (exists) channelId = id;
    }
    return { ...out, channelId };
  }

  startExit(channelId: bigint) {
    return this.execute(this.o.escrow, encodeFunctionData({ abi: escrowAbi, functionName: "startExit", args: [channelId] }));
  }

  /** Sign a cumulative voucher (QoreSign message-signing-v1 over the escrow's voucher text). */
  signVoucher(channelId: bigint, provider: Address, cumulativeWei: bigint): Uint8Array {
    const text = voucherText({ chainId: NET.evmChainId, escrow: this.o.escrow, channelId, provider, cumulativeWei });
    return mldsa87.sign(this.o.voucher.pqc.secretKey, qoreSignBytes(text));
  }

  private async providerKey(provider: Address) {
    const k = this.providerKeys.get(provider);
    if (k) return k;
    const st = await pqcKeyOf(provider);
    if (!st.registered || st.algorithm !== 1 || !st.possessionProven) throw new Error(`provider ${provider} has no proven ML-DSA-87 key`);
    const key = hexToBytes(st.pubkey);
    this.providerKeys.set(provider, key);
    return key;
  }

  /**
   * Pay-per-call fetch. Attaches the next cumulative voucher (previous + price). The running total only
   * advances when the provider confirms it consumed exactly that voucher; `receiptValid` tells whether its
   * ML-DSA-87 receipt over the response body verified.
   */
  async fetch(url: string, channel: { id: bigint; provider: Address; priceWei: bigint }) {
    const k = this.key(channel.id);
    const next = (this.cumulative.get(k) ?? 0n) + channel.priceWei;
    const sig = this.signVoucher(channel.id, channel.provider, next);
    const res = await fetch(url, { headers: { "x-tollgate-voucher": `${channel.id}.${next}.${Buffer.from(sig).toString("base64")}` } });
    const body = await res.text();
    if (res.status !== 200) return { ok: false as const, status: res.status, body, reason: "not paid" };
    if (res.headers.get("x-tollgate-cumulative") !== next.toString()) {
      return { ok: false as const, status: res.status, body, reason: "route did not consume the voucher (unpaid endpoint); nothing charged" };
    }
    this.cumulative.set(k, next); // the provider holds a voucher for `next` now
    this.persist();
    const receipt = res.headers.get("x-tollgate-receipt");
    const bodySha256 = createHash("sha256").update(body).digest("hex");
    const text = receiptText({ provider: channel.provider, channelId: channel.id, cumulativeWei: next, bodySha256 });
    const receiptValid =
      !!receipt && mldsa87.verify(await this.providerKey(channel.provider), qoreSignBytes(text), Uint8Array.from(Buffer.from(receipt, "base64")));
    return { ok: true as const, status: 200, body, cumulative: next, receiptValid };
  }

  spent(channelId: bigint) {
    return this.cumulative.get(this.key(channelId)) ?? 0n;
  }
}
