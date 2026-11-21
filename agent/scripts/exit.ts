/**
 * Close a channel as the owner's agent: startExit, wait out the challenge period, then finalizeExit.
 * Both calls go through the linked key (MsgExecuteEVM); a running provider (npm run serve) auto-claims meanwhile.
 *   npx tsx --env-file=.env scripts/exit.ts <channelId>
 */
import { fileURLToPath } from "node:url";
import { encodeFunctionData, formatEther, getAddress, type Address, type Hex } from "viem";
import { TollgateAgent } from "../src/agent.ts";
import { accountFromEnv, loadState, publicClient, requireAccount, sleep } from "../src/chain.ts";
import { escrowAbi } from "../src/escrow.ts";

const id = BigInt(process.argv[2] ?? "1");
const escrow = getAddress(loadState().escrow) as Address;
const owner = await accountFromEnv("TG_OWNER_MNEMONIC");
const agent = new TollgateAgent({
  escrow,
  owner: { evm: getAddress(owner.evm), cosmos: owner.cosmos },
  ed25519PrivateKey: process.env.TG_AGENT_ED25519 as Hex,
  voucher: await requireAccount("TG_VOUCHER_MNEMONIC"),
  relayer: await requireAccount("RELAYER_MNEMONIC"),
  statePath: fileURLToPath(new URL("../agent-vouchers.json", import.meta.url)),
});
type Ch = { deposit: bigint; paid: bigint; exitAt: bigint; closed: boolean };
const read = async () => (await publicClient.readContract({ address: escrow, abi: escrowAbi, functionName: "channel", args: [id] })) as unknown as Ch;

let c = await read();
if (c.closed) {
  console.log(`channel ${id} already closed`);
  process.exit(0);
}
if (c.exitAt === 0n) {
  const out = await agent.startExit(id);
  console.log(`startExit: success=${out.result.success} tx ${out.txHash}`);
  if (!out.result.success) process.exit(1);
  c = await read();
}
const now = BigInt(Math.floor(Date.now() / 1000));
const wait = c.exitAt > now ? Number(c.exitAt - now) + 15 : 5;
console.log(`challenge period: waiting ${wait}s (paid so far ${formatEther(c.paid)} of ${formatEther(c.deposit)} QOR)`);
await sleep(wait * 1000);
const fin = await agent.execute(escrow, encodeFunctionData({ abi: escrowAbi, functionName: "finalizeExit", args: [id] }));
c = await read();
console.log(`finalizeExit: success=${fin.result.success} tx ${fin.txHash}; closed=${c.closed}, paid to provider ${formatEther(c.paid)} QOR, refunded ${formatEther(c.deposit - c.paid)} QOR`);
process.exit(0);
