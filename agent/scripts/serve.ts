/**
 * Run the provider on its own (paid API + exit watcher that auto-claims), e.g. for an MCP client session:
 *   npm run serve            (port 8787; Ctrl+C to stop)
 */
import { fileURLToPath } from "node:url";
import { getAddress, parseEther, type Address } from "viem";
import { loadState, requireAccount } from "../src/chain.ts";
import { TollgateProvider } from "../src/provider.ts";

const provider = new TollgateProvider({
  account: await requireAccount("TG_PROVIDER_MNEMONIC"),
  escrow: getAddress(loadState().escrow) as Address,
  priceWei: parseEther(process.env.TOLLGATE_PRICE_QOR ?? "0.001"),
  port: Number(process.env.PORT ?? 8787),
  vouchersPath: fileURLToPath(new URL("../provider-vouchers.json", import.meta.url)),
});
const port = await provider.listen();
provider.watchExits(3000);
console.log(`tollgate provider ${provider.address} on http://127.0.0.1:${port} (exit watcher on)`);
const stop = () => {
  console.log(`stopping; paid calls served: ${provider.stats.paidCalls}, auto-claims: ${provider.stats.autoClaims.join(", ") || "none"}`);
  provider.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
