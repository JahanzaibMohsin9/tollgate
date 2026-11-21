/**
 * Tollgate MCP server: lets any MCP client (Claude Desktop, Claude Code, Cursor…) pay for APIs per call
 * through ML-DSA-87 payment channels, with on-chain limits the model cannot override.
 *
 * Tools
 *   tollgate_status        channel deposit / settled / spent, price, provider
 *   tollgate_open_channel  open a channel to the configured provider AS the owner's account, through the linked
 *                          agent key (MsgExecuteEVM; the chain enforces the owner's spending rule)
 *   tollgate_fetch         a paid GET against the provider's /v1/ API, with its ML-DSA-87 receipt verified
 *
 * What the model CANNOT do, whatever it is told: pay a provider the owner did not approve with an ML-DSA-87
 * signature, choose the voucher signer, exceed the per-tx / daily caps, call anything but the escrow's
 * open/topUp/startExit/finalizeExit, or touch the owner's keys: this process only knows the owner's ADDRESS.
 *
 * Env (agent/.env, all required, nothing is generated): TG_OWNER_EVM (public address), TG_AGENT_ED25519,
 * TG_VOUCHER_MNEMONIC, RELAYER_MNEMONIC, TOLLGATE_ESCROW, TOLLGATE_PROVIDER, TOLLGATE_PROVIDER_URL,
 * TOLLGATE_PRICE_WEI, optional TOLLGATE_CHANNEL.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { bytesToBech32 } from "@qorechain/sdk";
import { fileURLToPath } from "node:url";
import { formatEther, getAddress, hexToBytes, parseEther, type Address, type Hex } from "viem";
import { z } from "zod";
import { TollgateAgent } from "./agent.ts";
import { publicClient, requireAccount } from "./chain.ts";
import { escrowAbi } from "./escrow.ts";

const need = (k: string) => {
  const v = process.env[k]?.trim();
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

const escrow = getAddress(need("TOLLGATE_ESCROW"));
const provider = getAddress(need("TOLLGATE_PROVIDER"));
const providerUrl = need("TOLLGATE_PROVIDER_URL").replace(/\/$/, "");
const priceWei = BigInt(need("TOLLGATE_PRICE_WEI"));
let channelId = process.env.TOLLGATE_CHANNEL ? BigInt(process.env.TOLLGATE_CHANNEL) : undefined;
const ownerEvm = getAddress(need("TG_OWNER_EVM"));

const agent = new TollgateAgent({
  escrow,
  owner: { evm: ownerEvm, cosmos: bytesToBech32(hexToBytes(ownerEvm), "qor") },
  ed25519PrivateKey: need("TG_AGENT_ED25519") as Hex,
  voucher: await requireAccount("TG_VOUCHER_MNEMONIC"),
  relayer: await requireAccount("RELAYER_MNEMONIC"),
  statePath: fileURLToPath(new URL("../agent-vouchers.json", import.meta.url)),
});

// Restart-safe: resume the owner's latest channel to this provider if it is still open (read from chain).
if (channelId === undefined) {
  const [exists, id] = (await publicClient.readContract({ address: escrow, abi: escrowAbi, functionName: "lastChannel", args: [ownerEvm, provider] })) as [boolean, bigint];
  if (exists) {
    const c = (await publicClient.readContract({ address: escrow, abi: escrowAbi, functionName: "channel", args: [id] })) as { closed: boolean; exitAt: bigint };
    if (!c.closed && c.exitAt === 0n) channelId = id;
  }
}

const text = (o: unknown) => ({ content: [{ type: "text" as const, text: typeof o === "string" ? o : JSON.stringify(o, null, 2) }] });

const server = new McpServer({ name: "tollgate", version: "0.2.0" });

server.tool("tollgate_status", "Show the payment channel: deposit, settled on chain, spent by vouchers, price per call.", {}, async () => {
  if (channelId === undefined) return text("No channel yet. Use tollgate_open_channel.");
  const c = (await publicClient.readContract({ address: escrow, abi: escrowAbi, functionName: "channel", args: [channelId] })) as {
    deposit: bigint; paid: bigint; closed: boolean; exitAt: bigint; provider: Address;
  };
  return text({
    channel: channelId.toString(),
    provider: c.provider,
    deposit_qor: formatEther(c.deposit),
    settled_on_chain_qor: formatEther(c.paid),
    spent_by_vouchers_qor: formatEther(agent.spent(channelId)),
    remaining_qor: formatEther(c.deposit - agent.spent(channelId)),
    price_per_call_qor: formatEther(priceWei),
    closed: c.closed,
    exiting: c.exitAt !== 0n,
  });
});

server.tool(
  "tollgate_open_channel",
  "Open a new pay-per-call channel to the configured provider with a QOR deposit. Spends from the owner's account through the linked agent key; the chain enforces the owner's per-transaction and daily limits, and only owner-approved providers can be paid.",
  { deposit_qor: z.string().regex(/^\d+(\.\d+)?$/).describe('Deposit in QOR, e.g. "0.2"') },
  async ({ deposit_qor }) => {
    const out = await agent.openChannel(provider, parseEther(deposit_qor));
    if (!out.result.success || out.channelId === undefined) {
      return text({ opened: false, refused_by_chain: out.result.reason || out.result.vmError, tx: out.txHash });
    }
    channelId = out.channelId;
    return text({ opened: true, channel: channelId.toString(), tx: out.txHash });
  },
);

server.tool(
  "tollgate_fetch",
  "Call the provider's paid API: GET <provider>/v1/<…>. Pays one ML-DSA-87 voucher per call and verifies the provider's ML-DSA-87 receipt over the response.",
  { path: z.string().describe('A /v1/ path and query, e.g. "/v1/pq-status?address=0x…"') },
  async ({ path }) => {
    if (channelId === undefined) return text("No channel yet. Use tollgate_open_channel first.");
    if (!path.startsWith("/v1/")) return text("Only paid /v1/ endpoints of the configured provider are allowed.");
    const r = await agent.fetch(`${providerUrl}${path}`, { id: channelId, provider, priceWei });
    if (!r.ok) return text({ ok: false, status: r.status, reason: r.reason, body: r.body });
    if (!r.receiptValid) return text({ ok: false, paid_total_qor: formatEther(r.cumulative), reason: "provider receipt did NOT verify: do not trust this response", body: r.body });
    return text({ ok: true, receipt_verified: true, paid_total_qor: formatEther(r.cumulative), body: JSON.parse(r.body) });
  },
);

await server.connect(new StdioServerTransport());
