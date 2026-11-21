// Offline tests for the agent, provider and signed texts (no network, no funds):  npm test
// The on-chain parts are covered by the Foundry suite and the live runs in docs/TESTNET_RUN.md.
import { deriveUnifiedAccount, generateMnemonic } from "@qorechain/sdk";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Address, Hex } from "viem";
import { TollgateAgent } from "../src/agent.ts";
import { TollgateProvider } from "../src/provider.ts";
import { providerText, voucherText } from "../src/texts.ts";

const ESCROW = "0xc764E126AB277F9a1b46d45101A2F1Cf7BcdC408" as Address;
const PROVIDER = "0xb518Ae67AE27122D4314366cC58F18813dc88868" as Address;

test("voucherText is byte-identical to the text the live run checked against the contract", () => {
  // From docs/TESTNET_RUN.md section 6 (verified equal to ChannelEscrow.voucherText via eth_call).
  const expected = [
    "Tollgate voucher v1",
    "chain: 9800",
    "escrow: 0xc764e126ab277f9a1b46d45101a2f1cf7bcdc408",
    "channel: 0",
    "provider: 0xb518ae67ae27122d4314366cc58f18813dc88868",
    "cumulative wei: 1000000000000000",
  ].join("\n");
  assert.equal(voucherText({ chainId: 9800, escrow: ESCROW, channelId: 0n, provider: PROVIDER, cumulativeWei: 10n ** 15n }), expected);
});

test("providerText binds the voucher signer and is byte-identical to the live approval", () => {
  const expected = [
    "Tollgate provider v1",
    "chain: 9800",
    "escrow: 0xc764e126ab277f9a1b46d45101a2f1cf7bcdc408",
    "owner: 0x8d1d8bce31cd200587ec853d10ab5af45699459a",
    "provider: 0xb518ae67ae27122d4314366cc58f18813dc88868",
    "voucher signer: 0xc76b568737a209161d24317d66b42551749de243",
    "nonce: 0",
    "valid until: 1795218032",
  ].join("\n");
  const got = providerText({
    chainId: 9800,
    escrow: ESCROW,
    owner: "0x8D1D8BCe31cd200587Ec853D10aB5aF45699459A",
    provider: PROVIDER,
    voucherSigner: "0xC76b568737A209161D24317D66b42551749DE243",
    nonce: 0n,
    deadline: 1795218032n,
  });
  assert.equal(got, expected);
});

// ---------------------------------------------------------------- provider persistence (review P-1)

async function providerWith(file: string, escrow: Address = ESCROW) {
  const account = await deriveUnifiedAccount(generateMnemonic(), 0);
  return new TollgateProvider({ account, escrow, priceWei: 10n ** 15n, vouchersPath: file });
}

test("provider reads legacy files as its own escrow and keeps other escrows' vouchers on save", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tollgate-"));
  const file = join(dir, "vouchers.json");
  const other = "0x1111111111111111111111111111111111111111";
  writeFileSync(
    file,
    JSON.stringify({
      "3": { cumulative: "5", sig: Buffer.from([1, 2]).toString("base64") }, // legacy: this escrow
      [`${other}:3`]: { cumulative: "9", sig: Buffer.from([3]).toString("base64") }, // another escrow
    }),
  );
  const p = await providerWith(file);
  assert.equal(p.latestVoucher(3n)?.cumulative, 5n);
  (p as unknown as { persist(): void }).persist();
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(saved).sort(), [`${ESCROW.toLowerCase()}:3`, `${other}:3`].sort());
  assert.equal(saved[`${other}:3`].cumulative, "9", "another escrow's earned voucher must survive");
  assert.equal(existsSync(`${file}.tmp`), false, "atomic write leaves no temp file");
});

test("a provider for another escrow does not pick up these vouchers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tollgate-"));
  const file = join(dir, "vouchers.json");
  writeFileSync(file, JSON.stringify({ [`${ESCROW.toLowerCase()}:0`]: { cumulative: "7", sig: "AQ==" } }));
  const p = await providerWith(file, "0x2222222222222222222222222222222222222222");
  assert.equal(p.latestVoucher(0n), undefined);
});

// ---------------------------------------------------------------- agent: totals advance only on consumption

async function agentWith(statePath: string) {
  const voucher = await deriveUnifiedAccount(generateMnemonic(), 0);
  return new TollgateAgent({
    escrow: ESCROW,
    owner: { evm: "0x8D1D8BCe31cd200587Ec853D10aB5aF45699459A", cosmos: "qor1unused" },
    ed25519PrivateKey: `0x${"11".repeat(32)}` as Hex,
    voucher,
    relayer: voucher,
    statePath,
  });
}

async function fakeProvider(handler: (voucher: string | undefined) => { status: number; headers?: Record<string, string>; body: string }) {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    const v = req.headers["x-tollgate-voucher"] as string | undefined;
    if (v) seen.push(v);
    const r = handler(v);
    res.writeHead(r.status, { "content-type": "application/json", ...(r.headers ?? {}) });
    res.end(r.body);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, seen, close: () => server.close() };
}

test("agent does not advance its total on 402 or on a route that did not consume the voucher", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tollgate-"));
  const agent = await agentWith(join(dir, "agent.json"));
  const ch = { id: 1n, provider: PROVIDER, priceWei: 10n ** 15n };

  const unpaid = await fakeProvider(() => ({ status: 200, body: "{}" })); // no x-tollgate-cumulative header
  const r1 = await agent.fetch(`${unpaid.url}/health`, ch);
  unpaid.close();
  assert.equal(r1.ok, false);
  assert.equal(agent.spent(1n), 0n);

  const refusing = await fakeProvider(() => ({ status: 402, body: JSON.stringify({ error: "payment required" }) }));
  const r2 = await agent.fetch(`${refusing.url}/v1/x`, ch);
  refusing.close();
  assert.equal(r2.ok, false);
  assert.equal(agent.spent(1n), 0n);
  // the voucher it offered was exactly one call's price, ML-DSA-87 signed (4627 bytes)
  const [id, cum, sig] = refusing.seen[0].split(".");
  assert.equal(id, "1");
  assert.equal(cum, (10n ** 15n).toString());
  assert.equal(Buffer.from(sig, "base64").length, 4627);
});
