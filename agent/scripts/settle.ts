/**
 * Provider side: settle the latest voucher of a channel with ONE claim. If the provider has no usable EVM
 * window, it opens one scoped to the escrow first.
 *   npx tsx --env-file=.env scripts/settle.ts <channelId>
 */
import { fileURLToPath } from "node:url";
import { formatEther, getAddress, parseEther, type Address } from "viem";
import { loadState, publicClient, requireAccount } from "../src/chain.ts";
import { escrowAbi } from "../src/escrow.ts";
import { TollgateProvider } from "../src/provider.ts";

const id = BigInt(process.argv[2] ?? "2");
const escrow = getAddress(loadState().escrow) as Address;
const provider = new TollgateProvider({
  account: await requireAccount("TG_PROVIDER_MNEMONIC"),
  escrow,
  priceWei: parseEther("0.001"),
  vouchersPath: fileURLToPath(new URL("../provider-vouchers.json", import.meta.url)),
});
const v = provider.latestVoucher(id);
console.log(`channel ${id}: latest voucher ${v ? formatEther(v.cumulative) : "none"} QOR`);
const r = await provider.claimLatest(id);
if (!r) {
  console.log("nothing to settle");
  process.exit(0);
}
const c = (await publicClient.readContract({ address: escrow, abi: escrowAbi, functionName: "channel", args: [id] })) as unknown as { paid: bigint };
console.log(`claim(${formatEther(r.cumulative)} QOR) tx ${r.hash}, gas ~${r.gasEstimate}; settled on chain: ${formatEther(c.paid)} QOR`);
process.exit(0);
