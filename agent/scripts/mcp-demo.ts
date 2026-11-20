/**
 * End-to-end MCP check on testnet: a real MCP client spawns `src/mcp.ts` over stdio (exactly as Claude
 * Desktop / Claude Code would), opens a small channel through the linked agent key, makes paid calls and
 * reads the status. Appends the results to ../docs/TESTNET_RUN.md.
 *   npm run mcp-demo
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { appendFileSync } from "node:fs";
import { parseEther, type Address } from "viem";
import { accountFromEnv, loadState } from "../src/chain.ts";
import { TollgateProvider } from "../src/provider.ts";

const st = loadState();
const escrow = st.escrow as Address;
const providerAcc = await accountFromEnv("TG_PROVIDER_MNEMONIC");
const owner = await accountFromEnv("TG_OWNER_MNEMONIC");
const PRICE = parseEther("0.001");

const provider = new TollgateProvider({ account: providerAcc, escrow, priceWei: PRICE, port: 8788 });
await provider.listen();

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx", "--env-file=.env", "src/mcp.ts"],
  env: {
    ...(process.env as Record<string, string>),
    TOLLGATE_ESCROW: escrow,
    TOLLGATE_PROVIDER: providerAcc.evm,
    TOLLGATE_PROVIDER_URL: "http://127.0.0.1:8788",
    TOLLGATE_PRICE_WEI: PRICE.toString(),
  },
});
const client = new Client({ name: "tollgate-mcp-demo", version: "0.1.0" });
await client.connect(transport);

const out: string[] = ["", "## 10. The same flow through MCP (what Claude or Cursor would call)", ""];
const log = (s: string) => {
  console.log(s);
  out.push(s);
};
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[] };
  return r.content.map((c) => c.text).join("\n");
};

const tools = await client.listTools();
log(`- tools exposed: ${tools.tools.map((t) => `\`${t.name}\``).join(", ")}`);
log(`- \`tollgate_open_channel({deposit_qor: "0.2"})\` →\n\n\`\`\`json\n${await call("tollgate_open_channel", { deposit_qor: "0.2" })}\n\`\`\``);
for (let i = 0; i < 3; i++) {
  const r = await call("tollgate_fetch", { path: `/v1/pq-status?address=${owner.evm}` });
  if (i === 2) log(`- \`tollgate_fetch({path: "/v1/pq-status?address=…"})\` ×3, last →\n\n\`\`\`json\n${r}\n\`\`\``);
}
log(`- \`tollgate_status()\` →\n\n\`\`\`json\n${await call("tollgate_status")}\n\`\`\``);
log(`- \`tollgate_open_channel({deposit_qor: "5"})\` (above the on-chain caps; the model cannot override them) →\n\n\`\`\`json\n${await call("tollgate_open_channel", { deposit_qor: "5" })}\n\`\`\``);

await client.close();
provider.close();
appendFileSync(new URL("../../docs/TESTNET_RUN.md", import.meta.url), out.join("\n") + "\n");
console.log("appended to docs/TESTNET_RUN.md");
process.exit(0);
