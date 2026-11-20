// Chain plumbing for Tollgate (qorechain-diana). Native-lane broadcast pattern adapted from
// qorechain/build-before-qday workshop-1 scripts/window.ts (Apache-2.0).
import { StargateClient } from "@cosmjs/stargate";
import {
  EthNativeSigner,
  MSG_SEND_TYPE_URL,
  buildRegisterPqcKeyMsg,
  deriveUnifiedAccount,
  fetchPqcStatus,
  generateMnemonic,
  openEvmWindowMsg,
  signProofOfPossession,
  type UnifiedAccount,
} from "@qorechain/sdk";
import { qorechainTestnet } from "@qorechain/evm";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const NET = {
  chainId: "qorechain-diana",
  evmChainId: 9800,
  rest: "https://api-testnet.qore.host",
  rpc: "https://rpc-testnet.qore.host",
} as const;
export const EXPLORER_TX = "https://explore.qore.network/tx/";
export const PQC_KEY_STATUS: Address = "0x0000000000000000000000000000000000000a02";

const ENV_PATH = new URL("../.env", import.meta.url);
const STATE_PATH = new URL("../state.json", import.meta.url);

/** Account from a mnemonic in agent/.env under `name`; created and stored (never printed) if missing. */
export async function accountFromEnv(name: string): Promise<UnifiedAccount> {
  let m = process.env[name]?.trim();
  if (!m) {
    m = generateMnemonic();
    appendFileSync(ENV_PATH, `${name}="${m}"\n`);
    process.env[name] = m;
  }
  return deriveUnifiedAccount(m, 0);
}

/** A hex secret in agent/.env under `name`; created with `make()` and stored (never printed) if missing. */
export function secretFromEnv(name: string, make: () => string): string {
  let v = process.env[name]?.trim();
  if (!v) {
    v = make();
    appendFileSync(ENV_PATH, `${name}=${v}\n`);
    process.env[name] = v;
  }
  return v;
}

export function loadState(): Record<string, string> {
  return existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, "utf8")) : {};
}
export function saveState(s: Record<string, string>) {
  writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}

async function accountSequence(address: string) {
  const res = await fetch(`${NET.rest}/cosmos/auth/v1beta1/accounts/${address}`);
  if (!res.ok) throw new Error(`account ${address} not on chain (HTTP ${res.status}); fund it first`);
  const body = (await res.json()) as { account?: Record<string, unknown> };
  const acc = (body.account?.base_account ?? body.account ?? {}) as Record<string, string>;
  return { accountNumber: BigInt(acc.account_number ?? "0"), sequence: BigInt(acc.sequence ?? "0") };
}

export type NativeMsgs = Parameters<EthNativeSigner["sign"]>[0]["messages"];

/** Sign (hybrid or classical) and broadcast native messages; returns the full delivery result. */
export async function broadcastNative(acc: UnifiedAccount, mode: "hybrid" | "classical", messages: NativeMsgs, opts: { gas?: number; memo?: string } = {}) {
  const gas = opts.gas ?? 800_000;
  const fee = { amount: [{ denom: "uqor", amount: String(Math.ceil(gas * 0.125)) }], gas: String(gas) };
  const { accountNumber, sequence } = await accountSequence(acc.cosmos);
  const signer = new EthNativeSigner(acc, { signMode: mode, rest: NET.rest });
  const transport = await StargateClient.connect(NET.rpc);
  try {
    const res = await signer.signAndBroadcast(transport, { chainId: NET.chainId, accountNumber, sequence, fee, messages, memo: opts.memo ?? "" });
    if ((res as { code?: number }).code) throw new Error(`native tx failed (code ${(res as { code: number }).code}): ${(res as { rawLog?: string }).rawLog ?? ""}`);
    return res;
  } finally {
    transport.disconnect();
  }
}

export const sendQorMsg = (from: string, to: string, uqor: bigint) => ({
  typeUrl: MSG_SEND_TYPE_URL,
  value: { fromAddress: from, toAddress: to, amount: [{ denom: "uqor", amount: uqor.toString() }] },
});

/** Register the account's ML-DSA-87 key with proof of possession (classically signed: the one allowed case). */
export async function ensurePqcKey(acc: UnifiedAccount): Promise<string | undefined> {
  const st = await fetchPqcStatus({ rest: NET.rest, address: acc.cosmos });
  if (st.registered) return undefined;
  const proofOfPossession = signProofOfPossession({ chainId: NET.chainId, account: acc.cosmos, keypair: acc.pqc });
  const res = await broadcastNative(acc, "classical", [buildRegisterPqcKeyMsg(acc.cosmos, { pqcKeypair: acc.pqc, proofOfPossession })]);
  return res.transactionHash;
}

export async function openScopedWindow(acc: UnifiedAccount, p: { blocks: bigint; maxTxs: bigint; maxValueUqor: bigint; allowedTargets: string[] }) {
  const msg = openEvmWindowMsg({ sender: acc.cosmos, blocks: p.blocks, maxTxs: p.maxTxs, maxValue: p.maxValueUqor, allowedTargets: p.allowedTargets });
  return (await broadcastNative(acc, "hybrid", [msg])).transactionHash;
}

export const publicClient = createPublicClient({ chain: qorechainTestnet, transport: http() });
export const walletFor = (acc: UnifiedAccount) =>
  createWalletClient({ chain: qorechainTestnet, transport: http(), account: privateKeyToAccount(acc.privateKey as Hex) });

/** Fixed EIP-1559 caps so EVM-window budgets are predictable. */
export const FEES = { maxFeePerGas: 250_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n } as const;

export async function pqcKeyOf(address: Address): Promise<{ registered: boolean; algorithm: number; pubkey: Hex; possessionProven: boolean }> {
  const [registered, algorithm, pubkey, possessionProven] = (await publicClient.readContract({
    address: PQC_KEY_STATUS,
    abi: [{ type: "function", name: "pqcKeyStatus", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }, { type: "uint8" }, { type: "bytes" }, { type: "bool" }] }],
    functionName: "pqcKeyStatus",
    args: [address],
  })) as [boolean, number, Hex, boolean];
  return { registered, algorithm, pubkey, possessionProven };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
