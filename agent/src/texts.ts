// Byte-exact mirrors of ChannelEscrow.voucherText / providerText, plus the provider receipt text.
// All are signed as QoreSign message-signing-v1: "qorechain-msg-v1|qorechain-diana|" + text.
import { concat, toBytes, type Address } from "viem";

const lower = (a: string) => a.toLowerCase();

export function voucherText(p: { chainId: number; escrow: Address; channelId: bigint; provider: Address; cumulativeWei: bigint }): string {
  return [
    "Tollgate voucher v1",
    `chain: ${p.chainId}`,
    `escrow: ${lower(p.escrow)}`,
    `channel: ${p.channelId}`,
    `provider: ${lower(p.provider)}`,
    `cumulative wei: ${p.cumulativeWei}`,
  ].join("\n");
}

export function providerText(p: { chainId: number; escrow: Address; owner: Address; provider: Address; allowed: boolean; nonce: bigint }): string {
  return [
    "Tollgate provider v1",
    `chain: ${p.chainId}`,
    `escrow: ${lower(p.escrow)}`,
    `owner: ${lower(p.owner)}`,
    `provider: ${lower(p.provider)}`,
    `allowed: ${p.allowed}`,
    `nonce: ${p.nonce}`,
  ].join("\n");
}

/** What a provider signs for every paid response: binds the response body to the payment. */
export function receiptText(p: { provider: Address; channelId: bigint; cumulativeWei: bigint; bodySha256: string }): string {
  return [
    "Tollgate receipt v1",
    `provider: ${lower(p.provider)}`,
    `channel: ${p.channelId}`,
    `cumulative wei: ${p.cumulativeWei}`,
    `body sha256: ${p.bodySha256}`,
  ].join("\n");
}

export const qoreSignBytes = (text: string, cosmosChainId = "qorechain-diana") =>
  concat([toBytes(`qorechain-msg-v1|${cosmosChainId}|`), toBytes(text)]);
