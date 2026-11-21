/**
 * A short MCP session on an existing channel, printed the way a model sees it: tool list, tool calls, results.
 * Spawns src/mcp.ts over stdio exactly as Claude Desktop / Claude Code would. Opens no channel; the only
 * transaction is the over-limit open attempt, which the chain refuses (the relayer pays its fee).
 *   npm run mcp-session
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parseEther, type Address } from "viem";
import { accountFromEnv, loadState } from "../src/chain.ts";
import { TollgateProvider } from "../src/provider.ts";
import { fileURLToPath } from "node:url";

const st = loadState();
const escrow = st.escrow as Address;
const providerAcc = await accountFromEnv("TG_PROVIDER_MNEMONIC");
const owner = await accountFromEnv("TG_OWNER_MNEMONIC"); // only the address is passed to the MCP server
const PRICE = parseEther("0.001");

const provider = new TollgateProvider({
  account: providerAcc,
  escrow,
  priceWei: PRICE,
  port: 8790,
  vouchersPath: fileURLToPath(new URL("../provider-vouchers.json", import.meta.url)),
});
await provider.listen();

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx", "--env-file=.env", "src/mcp.ts"],
  env: {
    ...(process.env as Record<string, string>),
    TOLLGATE_ESCROW: escrow,
    TOLLGATE_PROVIDER: providerAcc.evm,
    TOLLGATE_PROVIDER_URL: "http://127.0.0.1:8790",
    TOLLGATE_PRICE_WEI: PRICE.toString(),
    TG_OWNER_EVM: owner.evm,
  },
});
const client = new Client({ name: "tollgate-mcp-session", version: "0.1.0" });
await client.connect(transport);

const show = (title: string, body: string) => {
  console.log(title);
  for (const l of body.split("\n")) console.log(`    ${l}`);
};
const call = async (name: string, args: Record<string, unknown> = {}) => {
  console.log(`\n> model calls ${name}(${Object.keys(args).length ? JSON.stringify(args) : ""})`);
  const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[] };
  show("  result:", r.content.map((c) => c.text).join("\n"));
};

const tools = await client.listTools();
console.log(`MCP server: tollgate (stdio). It knows the owner's ADDRESS only: ${owner.evm}`);
console.log(`tools the model sees:`);
for (const t of tools.tools) console.log(`  - ${t.name}: ${(t.description ?? "").split(". ")[0]}`);
await call("tollgate_status");
await call("tollgate_fetch", { path: `/v1/pq-status?address=${owner.evm}` });
await call("tollgate_open_channel", { deposit_qor: "5" });

await client.close();
provider.close();
process.exit(0);
