/**
 * Short live demo on an already-open channel: paid calls (no transactions), then ONE claim that settles them.
 *   npm run demo [-- <channelId> <calls>]      (defaults: the MCP demo's channel 1, 120 calls)
 * Needs the agent and provider keys in .env. Spends only the provider's window fee and claim gas.
 */
import { evmWindowCost } from "@qorechain/evm";
import { fileURLToPath } from "node:url";
import { formatEther, getAddress, parseEther, type Address, type Hex } from "viem";
import { TollgateAgent } from "../src/agent.ts";
import { FEES, NET, accountFromEnv, loadState, openScopedWindow, publicClient, requireAccount, sleep } from "../src/chain.ts";
import { escrowAbi } from "../src/escrow.ts";
import { TollgateProvider } from "../src/provider.ts";
import { voucherText } from "../src/texts.ts";

const st = loadState();
const escrow = getAddress(st.escrow) as Address;
const channelId = BigInt(process.argv[2] ?? "1");
const CALLS = Number(process.argv[3] ?? "120");
const PRICE = parseEther("0.001");
const say = (s = "") => console.log(s);
const qor = (wei: bigint) => `${formatEther(wei)} QOR`;

const owner = await accountFromEnv("TG_OWNER_MNEMONIC"); // only its public address is used here
const providerAcc = await requireAccount("TG_PROVIDER_MNEMONIC");
const agent = new TollgateAgent({
  escrow,
  owner: { evm: getAddress(owner.evm), cosmos: owner.cosmos },
  ed25519PrivateKey: process.env.TG_AGENT_ED25519 as Hex,
  voucher: await requireAccount("TG_VOUCHER_MNEMONIC"),
  relayer: await requireAccount("RELAYER_MNEMONIC"),
  statePath: fileURLToPath(new URL("../agent-vouchers.json", import.meta.url)),
});

type Ch = { payer: Address; provider: Address; voucherSigner: Address; deposit: bigint; paid: bigint; exitAt: bigint; closed: boolean };
const channel = async () => (await publicClient.readContract({ address: escrow, abi: escrowAbi, functionName: "channel", args: [channelId] })) as unknown as Ch;

say(`Tollgate live demo on qorechain-diana, block ${await publicClient.getBlockNumber()}`);
const before = await channel();
say(`escrow ${escrow}`);
say(`channel ${channelId}: payer ${before.payer.slice(0, 10)}... (owner)  provider ${before.provider.slice(0, 10)}...`);
say(`  deposit ${qor(before.deposit)}  settled on chain ${qor(before.paid)}  voucher signer ${before.voucherSigner.slice(0, 10)}... (owner-approved)`);
say();

const provider = new TollgateProvider({
  account: providerAcc,
  escrow,
  priceWei: PRICE,
  port: 8789,
  vouchersPath: fileURLToPath(new URL("../provider-vouchers.json", import.meta.url)),
});
await provider.listen();
const url = `http://127.0.0.1:8789/v1/pq-status?address=${owner.evm}`;
const ch = { id: channelId, provider: getAddress(before.provider) as Address, priceWei: PRICE };

const noPay = await fetch(url);
say(`GET /v1/pq-status without a voucher -> HTTP ${noPay.status} ${JSON.parse(await noPay.text()).error}`);
const next = agent.spent(channelId) + PRICE;
say(`next voucher, signed with the agent's ML-DSA-87 key (4627-byte signature):`);
for (const l of voucherText({ chainId: NET.evmChainId, escrow, channelId, provider: ch.provider, cumulativeWei: next }).split("\n")) say(`  | ${l}`);
say();

const t0 = Date.now();
let valid = 0;
let last: Awaited<ReturnType<typeof agent.fetch>> | undefined;
for (let i = 1; i <= CALLS; i++) {
  last = await agent.fetch(url, ch);
  if (!last.ok) throw new Error(`call ${i} failed: ${last.status} ${last.body}`);
  if (last.receiptValid) valid++;
  if (i % 20 === 0 || i === CALLS) {
    const s = (Date.now() - t0) / 1000;
    say(`paid calls ${String(i).padStart(3)}/${CALLS}  vouchers ${qor(agent.spent(channelId)).padEnd(10)}  receipts valid ${valid}/${i}  ${(i / s).toFixed(1)} calls/s  transactions 0`);
  }
}
if (last?.ok) say(`last response: ${last.body}`);
say();

say(`provider settles everything with ONE claim:`);
const perTx = evmWindowCost({ gas: 1_000_000n, maxFeePerGas: FEES.maxFeePerGas });
const win = await openScopedWindow(providerAcc, { blocks: 300n, maxTxs: 1n, maxValueUqor: perTx, allowedTargets: [escrow] });
say(`  scoped EVM window: 1 tx, only to the escrow  ${win.slice(0, 16)}...`);
await sleep(6000);
const c = await provider.claimLatest(channelId);
if (!c) throw new Error("nothing to claim");
const r = await publicClient.getTransactionReceipt({ hash: c.hash });
say(`  claim(${qor(c.cumulative)}) in block ${r.blockNumber}, gas ~${c.gasEstimate}  ${c.hash.slice(0, 18)}...`);
const after = await channel();
say(`  channel ${channelId} settled on chain: ${qor(before.paid)} -> ${qor(after.paid)}`);
say(`  ${CALLS} calls, 1 transaction.`);
provider.close();
process.exit(0);
