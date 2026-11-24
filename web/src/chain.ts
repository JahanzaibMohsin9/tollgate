import {
  BaseError,
  ContractFunctionRevertedError,
  concat,
  createPublicClient,
  defineChain,
  http,
  parseAbi,
  toBytes,
  toHex,
  type Address,
  type Hex,
} from "viem";

export const diana = defineChain({
  id: 9800,
  name: "QoreChain testnet (qorechain-diana)",
  nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
  rpcUrls: { default: { http: ["https://evm-testnet.qore.host"] } },
});
export const client = createPublicClient({ chain: diana, transport: http() });

/** The live deployment from docs/TESTNET_RUN.md. */
export const LIVE = {
  escrow: "0xc764E126AB277F9a1b46d45101A2F1Cf7BcdC408",
  owner: "0x8D1D8BCe31cd200587Ec853D10aB5aF45699459A",
  voucherSigner: "0xC76b568737A209161D24317D66b42551749DE243",
  provider: "0xb518Ae67AE27122D4314366cC58F18813dc88868",
  relayer: "0x1D71563914D38D25b33962EC32DA9fB8F7f292C9",
} as const satisfies Record<string, Address>;

export const REPO = "https://github.com/JahanzaibMohsin9/tollgate";
export const VIDEO = "https://youtu.be/kXrFDJ1bq_0";
export const DOC = (p: string) => `${REPO}/blob/main/${p}`;
export const EXPLORER_TX = "https://explore.qore.network/tx/";
export const PRICE_WEI = 1_000_000_000_000_000n; // 0.001 QOR per call in every recorded run

export const escrowAbi = parseAbi([
  "struct Channel { address payer; address provider; address voucherSigner; bytes32 keyHash; uint128 deposit; uint128 paid; uint64 exitAt; bool closed; }",
  "function channelCount() view returns (uint256)",
  "function channel(uint256 id) view returns (Channel)",
  "function challengePeriod() view returns (uint256)",
  "function approvedSigner(address owner, address provider) view returns (address)",
  "function lastChannel(address payer, address provider) view returns (bool exists, uint256 id)",
  "function voucherText(uint256 id, uint256 cumulative) view returns (bytes)",
  "function open(address provider) payable returns (uint256)",
  "function claim(uint256 id, uint256 cumulative, bytes voucherKey, bytes voucherSig)",
  "error InvalidSignature()",
  "error ProviderNotAllowed(address provider)",
  "error ZeroDeposit()",
  "error ChannelClosed(uint256 id)",
  "error NotIncreasing(uint256 paid, uint256 due)",
  "error WrongVoucherKey(uint256 id)",
  "error UnknownChannel(uint256 id)",
  "error PqcPrecompileUnavailable(address precompile)",
  "error PqcKeyNotRegistered(address account)",
  "error PqcUnsupportedAlgorithm(address account, uint8 alg)",
  "error PqcPossessionNotProven(address account)",
]);

export type Channel = {
  payer: Address;
  provider: Address;
  voucherSigner: Address;
  keyHash: Hex;
  deposit: bigint;
  paid: bigint;
  exitAt: bigint;
  closed: boolean;
};

export const PQC_VERIFY = "0x0000000000000000000000000000000000000a01" as const;
export const PQC_KEY_STATUS = "0x0000000000000000000000000000000000000a02" as const;
const pqcAbi = parseAbi([
  "function pqcVerify(bytes pubkey, bytes signature, bytes message) view returns (bool)",
  "function pqcKeyStatus(address account) view returns (bool registered, uint8 algorithmId, bytes pubkey, bool possessionProven)",
]);

export const readChannel = async (id: bigint) =>
  (await client.readContract({ address: LIVE.escrow, abi: escrowAbi, functionName: "channel", args: [id] })) as Channel;

export async function keyStatus(account: Address) {
  const [registered, alg, pubkey, proven] = (await client.readContract({
    address: PQC_KEY_STATUS,
    abi: pqcAbi,
    functionName: "pqcKeyStatus",
    args: [account],
  })) as [boolean, number, Hex, boolean];
  return { registered, alg, pubkey, proven, keyBytes: (pubkey.length - 2) / 2, ready: registered && alg === 1 && proven };
}

/** Straight eth_call to the pqcVerify precompile: the same check the escrow runs inside claim(). */
export const pqcVerify = async (pubkey: Hex, signature: Hex, message: Hex) =>
  (await client.readContract({ address: PQC_VERIFY, abi: pqcAbi, functionName: "pqcVerify", args: [pubkey, signature, message] })) as boolean;

/** Byte-exact mirror of ChannelEscrow.voucherText (and agent/src/texts.ts). */
export const voucherText = (channelId: bigint, provider: Address, cumulativeWei: bigint) =>
  [
    "Tollgate voucher v1",
    `chain: ${diana.id}`,
    `escrow: ${LIVE.escrow.toLowerCase()}`,
    `channel: ${channelId}`,
    `provider: ${provider.toLowerCase()}`,
    `cumulative wei: ${cumulativeWei}`,
  ].join("\n");

/** QoreSign message-signing-v1: the bytes an ML-DSA-87 key signs for a given text. */
export const qoreSignBytes = (text: string | Uint8Array) =>
  toHex(concat([toBytes("qorechain-msg-v1|qorechain-diana|"), typeof text === "string" ? toBytes(text) : text]));

/** Name of the custom error a call reverts with, "OK" if it succeeds. */
export async function outcome(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "OK";
  } catch (e) {
    if (e instanceof BaseError) {
      const rev = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
      if (rev?.data?.errorName) return rev.data.errorName;
      return e.shortMessage;
    }
    return String(e);
  }
}

/** Parse the x-tollgate-voucher header the agent sends: <channel>.<cumulative wei>.<base64 signature>. */
export function parseVoucher(raw: string): { channelId: bigint; cumulative: bigint; signature: Hex } {
  const parts = raw.trim().replace(/^x-tollgate-voucher:\s*/i, "").split(".");
  if (parts.length !== 3) throw new Error("expected <channel>.<cumulative wei>.<base64 signature>");
  const [id, cum, b64] = parts;
  if (!/^\d+$/.test(id) || !/^\d+$/.test(cum)) throw new Error("channel and cumulative must be whole numbers");
  let bin: string;
  try {
    bin = atob(b64.replace(/\s+/g, ""));
  } catch {
    throw new Error("the signature is not valid base64");
  }
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return { channelId: BigInt(id), cumulative: BigInt(cum), signature: toHex(bytes) };
}

export const encodeVoucher = (channelId: bigint, cumulative: bigint, signature: Hex) => {
  const bytes = toBytes(signature);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return `${channelId}.${cumulative}.${btoa(bin)}`;
};

// ------------------------------------------------------------------ recorded transactions, re-read live from REST

export type Proof = { label: string; detail: string; hash: string; expect: "executed" | "refused"; source: string };

export const PROOFS: Proof[] = [
  {
    label: "1,000 paid calls, claim 1 of 2",
    detail: "the provider settles 600 calls with one ML-DSA-87 voucher (≈311k gas)",
    hash: "2EADA5A2C6B540E83157AB38FFF4299C27488BB8A3EB62E4C68E286F51945DC5",
    expect: "executed",
    source: "docs/TESTNET_RUN.md#7",
  },
  {
    label: "1,000 paid calls, claim 2 of 2",
    detail: "the exit watcher auto-claims the last 400 calls during the challenge period",
    hash: "325E2843AF65CCB3614DB464B38E26245D7EFEDD99DC94E9F704B10A07BD1054",
    expect: "executed",
    source: "docs/TESTNET_RUN.md#9",
  },
  {
    label: "Prompt injection: open a channel to an attacker",
    detail: "the spending rule admits 0.5 QOR; the escrow reverts with ProviderNotAllowed",
    hash: "518E67212B04308B35A3981371F5DF5146A0EA7F60683617D73DA7CCA5130B97",
    expect: "refused",
    source: "docs/TESTNET_RUN.md#11",
  },
  {
    label: "Prompt injection, first run: daily cap",
    detail: "the owner's spending rule refuses it on the 5 QOR daily cap",
    hash: "DA06FDE27921755FC1D9C4B9BD58EACAEC24679A960F688721ACC40496FDA69E",
    expect: "refused",
    source: "docs/TESTNET_RUN.md#8",
  },
  {
    label: "The agent tries to approve the attacker itself",
    detail: "setProvider is not in the rule's allowed EVM calls",
    hash: "994E7A2D59C746BDF79E7FB0FCE8273195FC788FD91FFF10EFCEAFA4CCAE0A1C",
    expect: "refused",
    source: "docs/TESTNET_RUN.md#8",
  },
  {
    label: "Claude asks for a 5 QOR channel",
    detail: "real Claude session: refused by the 2 QOR per-transaction cap",
    hash: "48A1F1BD77D8A7AD2CDD940674B46EB9ADB8F3C8D644CC5135F9A7C136E74EEE",
    expect: "refused",
    source: "docs/claude-session/README.md",
  },
  {
    label: "Claude opens channel 2 with 0.2 QOR",
    detail: "through the linked agent key (MsgExecuteEVM; the relayer pays the fee)",
    hash: "AE5DB38488286D29E116A960E2DD03036E844B27D1079F279D6790AE01A9ADB8",
    expect: "executed",
    source: "docs/claude-session/README.md",
  },
  {
    label: "One claim settles Claude's 3 calls",
    detail: "after the provider opened its own scoped EVM window",
    hash: "4E5E8ED14864620A89DC81CC5BB3B20BD3B91895EBD855976969756D85F871C6",
    expect: "executed",
    source: "docs/claude-session/README.md",
  },
];

export type ProofStatus = { executed: boolean; reason?: string; height: string; time: string };

/** Read a recorded tx from the Cosmos REST API. A refused linked-key execution is a code-0 tx with an
 *  abstractaccount_execution_failed event: the nonce is used, no value moves. */
export async function proofStatus(hash: string): Promise<ProofStatus> {
  const res = await fetch(`/lcd-testnet/cosmos/tx/v1beta1/txs/${hash}`);
  if (!res.ok) throw new Error(`REST ${res.status}`);
  const { tx_response: r } = (await res.json()) as {
    tx_response: { code: number; raw_log: string; height: string; timestamp: string; events: { type: string; attributes: { key: string; value: string }[] }[] };
  };
  if (r.code !== 0) return { executed: false, reason: r.raw_log, height: r.height, time: r.timestamp };
  const failed = r.events.find((e) => e.type === "abstractaccount_execution_failed");
  const reason = failed?.attributes.find((a) => a.key === "reason")?.value;
  return { executed: !failed, reason, height: r.height, time: r.timestamp };
}
