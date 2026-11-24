/**
 * Print an MCP client config that runs BOTH servers side by side: Tollgate (pays per call) and QoreChain's
 * read-only server @qorechain/mcp (chain reads). Absolute paths, so it works from any directory.
 *   npm run --silent mcp-config > ../.mcp.session.json
 *   claude --mcp-config ../.mcp.session.json --strict-mcp-config ...
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { qorechainMcpBin } from "../src/qorechain.ts";

const agentDir = fileURLToPath(new URL("..", import.meta.url));
// MCP clients may start servers from any directory, so tsx is passed as a file URL, not a package name.
const tsx = import.meta.resolve("tsx");
const config = {
  mcpServers: {
    tollgate: {
      command: process.execPath,
      args: ["--import", tsx, `--env-file=${join(agentDir, ".env")}`, join(agentDir, "src", "mcp.ts")],
      cwd: agentDir,
      env: {
        TOLLGATE_ESCROW: process.env.TOLLGATE_ESCROW ?? "0xc764E126AB277F9a1b46d45101A2F1Cf7BcdC408",
        TOLLGATE_PROVIDER: process.env.TOLLGATE_PROVIDER ?? "0xb518Ae67AE27122D4314366cC58F18813dc88868",
        TOLLGATE_PROVIDER_URL: process.env.TOLLGATE_PROVIDER_URL ?? "http://127.0.0.1:8787",
        TOLLGATE_PRICE_WEI: process.env.TOLLGATE_PRICE_WEI ?? "1000000000000000",
        TG_OWNER_EVM: process.env.TG_OWNER_EVM ?? "0x8D1D8BCe31cd200587Ec853D10aB5aF45699459A",
      },
    },
    qorechain: { command: process.execPath, args: [qorechainMcpBin(), "--network", "testnet"] },
  },
};
console.log(JSON.stringify(config, null, 2));
