/**
 * Tollgate MCP server: lets any MCP client (Claude Desktop, Claude Code, Cursor…) pay for APIs per call
 * through ML-DSA-87 payment channels, with on-chain limits the model cannot override.
 *
 * Tools
 *   tollgate_status        channel deposit / paid / spent, limits, provider
 *   tollgate_open_channel  open (or top up) a channel to the configured provider, AS the owner's account,
 *                          through the linked agent key (MsgExecuteEVM; spending rule enforced by the chain)
 *   tollgate_fetch         a paid GET against the provider, with the provider's ML-DSA-87 receipt verified
 *
 * What the model CANNOT do, whatever it is told: pay a provider the owner did not allowlist with an ML-DSA-87
 * signature, exceed the per-tx / daily caps, call anything but the escrow's open/topUp/startExit/finalizeExit,
 * or touch the owner's keys (it never has them).
 *
 * Env (agent/.env): TG_OWNER_MNEMONIC (only its PUBLIC address is used), TG_VOUCHER_MNEMONIC,
 * TG_AGENT_ED25519, RELAYER_MNEMONIC, TOLLGATE_ESCROW, TOLLGATE_PROVIDER, TOLLGATE_PROVIDER_URL,
 * TOLLGATE_PRICE_WEI, optional TOLLGATE_CHANNEL.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { formatEther, getAddress, parseEther, type Address, type Hex } from "viem";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { TollgateAgent } from "./agent.ts";
import { accountFromEnv, publicClient } from "./chain.ts";
import { escrowAbi } from "./escrow.ts";

const need = (k: string) => {
  const v = process.env[k]?.trim();
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

const escrow = getAddress(need("TOLLGATE_ESCROW"));
const provider = getAddress(need("TOLLGATE_PROVIDER"));
const providerUrl = need("TOLLGATE_PROVIDER_URL").replace(/\/$/, "");
const priceWei = BigInt(process.env.TOLLGATE_PRICE_WEI ?? parseEther("0.001").toString());
let channelId = process.env.TOLLGATE_CHANNEL ? BigInt(process.env.TOLLGATE_CHANNEL) : undefined;

const owner = await accountFromEnv("TG_OWNER_MNEMONIC"); // only the public address is used here
const agent = new TollgateAgent({
  escrow,
  owner: { cosmos: owner.cosmos, evm: getAddress(owner.evm) },
  ed25519PrivateKey: need("TG_AGENT_ED25519") as Hex,
  voucher: await accountFromEnv("TG_VOUCHER_MNEMONIC"),
  relayer: await accountFromEnv("RELAYER_MNEMONIC"),
  statePath: fileURLToPath(new URL("../agent-vouchers.json", import.meta.url)),
});

const text = (o: unknown) => ({ content: [{ type: "text" as const, text: typeof o === "string" ? o : JSON.stringify(o, null, 2) }] });

const server = new McpServer({ name: "tollgate", version: "0.1.0" });

server.tool("tollgate_status", "Show the payment channel: deposit, paid on chain, spent off chain, price per call.", {}, async () => {
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
  "Open a pay-per-call channel to the configured provider with a QOR deposit. Spends from the owner's account through the linked agent key; the chain enforces the owner's per-transaction and daily limits and only allows owner-approved providers.",
  { deposit_qor: z.string().describe("Deposit in QOR, e.g. \"0.2\"") },
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
  "Call the paid API (GET <provider>/<path>). Pays one ML-DSA-87 voucher per call and verifies the provider's ML-DSA-87 receipt over the response.",
  { path: z.string().describe("Path and query, e.g. \"/v1/pq-status?address=0x…\"") },
  async ({ path }) => {
    if (channelId === undefined) return text("No channel yet. Use tollgate_open_channel first.");
    const r = await agent.fetch(`${providerUrl}${path.startsWith("/") ? path : `/${path}`}`, { id: channelId, provider, priceWei });
    if (!r.ok) return text({ ok: false, status: r.status, body: r.body });
    return text({ ok: true, receipt_verified: r.receiptValid, paid_total_qor: formatEther(r.cumulative), body: JSON.parse(r.body) });
  },
);

await server.connect(new StdioServerTransport());
