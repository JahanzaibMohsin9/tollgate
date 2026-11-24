/**
 * Tollgate's preflight on its own: ask QoreChain's read-only MCP server (@qorechain/mcp) about the owner, the
 * provider and the escrow before paying. Prints what tollgate_preflight returns. Read-only, sends nothing.
 *   npm run preflight            (optional: npm run preflight -- 0.5   to check a planned 0.5 QOR deposit)
 */
import { getAddress, parseEther, type Address } from "viem";
import { loadState, requireAccount } from "../src/chain.ts";
import { QorechainReads } from "../src/qorechain.ts";

const qc = await QorechainReads.start("testnet");
const out = await qc.preflight({
  escrow: getAddress(loadState().escrow) as Address,
  owner: (await requireAccount("TG_OWNER_MNEMONIC")).evm as Address,
  provider: (await requireAccount("TG_PROVIDER_MNEMONIC")).evm as Address,
  depositWei: process.argv[2] ? parseEther(process.argv[2]) : undefined,
});
console.log(JSON.stringify(out, null, 2));
await qc.close();
