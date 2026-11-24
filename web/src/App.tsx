import { mldsa87 } from "@qorechain/pqc";
import { useEffect, useState } from "react";
import { bytesToHex, formatEther, hexToBytes, hexToString, keccak256, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  DOC,
  EXPLORER_TX,
  LIVE,
  PRICE_WEI,
  PROOFS,
  REPO,
  VIDEO,
  client,
  encodeVoucher,
  escrowAbi,
  keyStatus,
  outcome,
  parseVoucher,
  pqcVerify,
  proofStatus,
  qoreSignBytes,
  readChannel,
  voucherText,
  type Channel,
  type ProofStatus,
} from "./chain.ts";
import { VOUCHER_1000_CALLS, VOUCHER_CLAUDE_SESSION } from "./vouchers.ts";

type Check = { label: string; detail?: string; status: "pending" | "ok" | "bad"; value?: string };
const short = (a: string) => `${a.slice(0, 8)}…${a.slice(-6)}`;
const qor = (wei: bigint) => `${formatEther(wei)} QOR`;
const errText = (e: unknown) => String((e as { shortMessage?: string; message?: string })?.shortMessage ?? (e as Error)?.message ?? e);

function Checks({ items }: { items: Check[] }) {
  return (
    <ul className="checks">
      {items.map((c, i) => (
        <li key={i} className={c.status}>
          <span className="icon">{c.status === "ok" ? "✓" : c.status === "bad" ? "✗" : "…"}</span>
          <span>
            <b>{c.label}</b>
            {c.detail && <span className="small"> · {c.detail}</span>}
          </span>
          {c.value && <span className="val">{c.value}</span>}
        </li>
      ))}
    </ul>
  );
}

const ROLE: Record<string, string> = {
  [LIVE.owner.toLowerCase()]: "owner",
  [LIVE.provider.toLowerCase()]: "provider",
  [LIVE.voucherSigner.toLowerCase()]: "agent voucher key",
};
const Addr = ({ a }: { a: Address }) => (
  <span title={a}>
    <code>{short(a)}</code>
    {ROLE[a.toLowerCase()] && <span className="small"> {ROLE[a.toLowerCase()]}</span>}
  </span>
);

const channelState = (c: Channel) => (c.closed ? "closed" : c.exitAt !== 0n ? "exiting" : "open");
const CHANNEL_STORY: Record<string, string> = {
  "0": "1,000 paid calls, settled with 2 claims",
  "1": "scripted MCP client run",
  "2": "the real Claude session",
};

// ------------------------------------------------------------------ 1. the escrow, read now
function Escrow({ onChannels }: { onChannels: (c: Channel[]) => void }) {
  const [rows, setRows] = useState<Channel[]>();
  const [checks, setChecks] = useState<Check[]>([]);
  const [meta, setMeta] = useState<{ block: bigint; challenge: bigint }>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    (async () => {
      const [block, count, challenge] = await Promise.all([
        client.getBlockNumber(),
        client.readContract({ address: LIVE.escrow, abi: escrowAbi, functionName: "channelCount" }) as Promise<bigint>,
        client.readContract({ address: LIVE.escrow, abi: escrowAbi, functionName: "challengePeriod" }) as Promise<bigint>,
      ]);
      setMeta({ block, challenge });
      const all = await Promise.all(Array.from({ length: Number(count) }, (_, i) => readChannel(BigInt(i))));
      setRows(all);
      onChannels(all);

      const approved = (await client.readContract({ address: LIVE.escrow, abi: escrowAbi, functionName: "approvedSigner", args: [LIVE.owner, LIVE.provider] })) as Address;
      const ks = await keyStatus(LIVE.voucherSigner);
      const pinnedOk = all.length > 0 && all.every((c) => c.keyHash === keccak256(ks.pubkey));
      const settled = all.reduce((s, c) => s + c.paid, 0n);
      setChecks([
        {
          label: "Provider approved by the owner's ML-DSA-87 signature",
          detail: "approvedSigner(owner, provider); the model cannot change it",
          status: approved.toLowerCase() === LIVE.voucherSigner.toLowerCase() ? "ok" : "bad",
          value: `voucher signer ${short(approved)}`,
        },
        {
          label: "Agent's voucher key is registered on chain",
          detail: "pqcKeyStatus precompile 0x…0a02",
          status: ks.ready ? "ok" : "bad",
          value: `ML-DSA-87 ${ks.keyBytes} B · possession ${ks.proven}`,
        },
        {
          label: "That key is the one pinned in every channel",
          detail: "keccak256(key) = keyHash stored at open",
          status: pinnedOk ? "ok" : "bad",
          value: pinnedOk ? "matches" : "rotated since open",
        },
        { label: "Settled to the provider across all channels", detail: "sum of paid", status: "ok", value: qor(settled) },
      ]);
    })().catch((e) => setError(errText(e)));
  }, []);

  return (
    <section className="card">
      <h2>1 · The escrow, read from testnet now</h2>
      <p className="small">
        ChannelEscrow <code>{LIVE.escrow}</code> on qorechain-diana (EVM 9800)
        {meta && (
          <>
            {" "}
            · block {meta.block.toString()} · challenge period {meta.challenge.toString()} s
          </>
        )}
        . Channels are read with <code>channel(id)</code>, not from logs: logs emitted inside <code>MsgExecuteEVM</code> are not indexed by{" "}
        <code>eth_getLogs</code> on QoreChain today.
      </p>
      {error && <div className="verdict bad">Could not read the testnet: {error}</div>}
      {!rows && !error && <p className="small">Reading…</p>}
      {rows && (
        <div className="table">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Payer</th>
                <th>Provider</th>
                <th>Deposit</th>
                <th>Settled</th>
                <th>Refunded / left</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c, i) => (
                <tr key={i}>
                  <td>
                    {i}
                    {CHANNEL_STORY[String(i)] && <div className="small">{CHANNEL_STORY[String(i)]}</div>}
                  </td>
                  <td>
                    <Addr a={c.payer} />
                  </td>
                  <td>
                    <Addr a={c.provider} />
                  </td>
                  <td className="num">{formatEther(c.deposit)}</td>
                  <td className="num">{formatEther(c.paid)}</td>
                  <td className="num">{formatEther(c.deposit - c.paid)}</td>
                  <td>
                    <span className={`pill ${channelState(c)}`}>{channelState(c)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Checks items={checks} />
    </section>
  );
}

// ------------------------------------------------------------------ 2. attacks, simulated now
function Attacks({ channels }: { channels?: Channel[] }) {
  const [items, setItems] = useState<Check[]>([]);
  const [running, setRunning] = useState(false);
  const live = channels?.map((c, i) => ({ c, id: BigInt(i) })).filter(({ c }) => !c.closed && c.exitAt === 0n).at(-1);

  async function run() {
    if (!live) return;
    setRunning(true);
    const out: Check[] = [];
    const push = (c: Check) => {
      out.push(c);
      setItems([...out]);
    };
    try {
      // a. the injection: pay a provider the owner never approved
      const attacker = privateKeyToAccount(generatePrivateKey()).address;
      const r1 = await outcome(
        client.simulateContract({ account: LIVE.owner, address: LIVE.escrow, abi: escrowAbi, functionName: "open", args: [attacker], value: 10n ** 16n }),
      );
      push({
        label: "Open a channel to an attacker, as the owner",
        detail: `fresh address ${short(attacker)}, 0.01 QOR`,
        status: r1 === "ProviderNotAllowed" ? "ok" : "bad",
        value: r1,
      });

      const { c, id } = live;
      const ks = await keyStatus(c.voucherSigner);
      const cumulative = c.paid + 50n * PRICE_WEI;
      const message = qoreSignBytes(voucherText(id, c.provider, cumulative));

      // b. a voucher signed by someone else's ML-DSA-87 key, claimed against the pinned key
      const fake = mldsa87.keygen(crypto.getRandomValues(new Uint8Array(32)));
      const forged = bytesToHex(mldsa87.sign(fake.secretKey, hexToBytes(message)));
      const claim = (key: Hex, sig: Hex, cum = cumulative) =>
        client.simulateContract({ account: LIVE.relayer, address: LIVE.escrow, abi: escrowAbi, functionName: "claim", args: [id, cum, key, sig] });
      const r2 = await outcome(claim(ks.pubkey, forged));
      push({
        label: `Claim 50 more calls on channel ${id} with a forged voucher`,
        detail: "ML-DSA-87 key generated in your browser just now",
        status: r2 === "InvalidSignature" ? "ok" : "bad",
        value: r2,
      });

      // c. bring your own key
      const r3 = await outcome(claim(bytesToHex(fake.publicKey), forged));
      push({ label: "Same claim, passing the attacker's own public key", detail: "the escrow pinned the agent's key at open", status: r3 === "WrongVoucherKey" ? "ok" : "bad", value: r3 });

      // d. replay the real voucher the provider already settled
      if (id === 2n) {
        const v = parseVoucher(VOUCHER_CLAUDE_SESSION);
        const r4 = await outcome(claim(ks.pubkey, v.signature, v.cumulative));
        push({ label: "Replay Claude's real, already-settled voucher", detail: "a valid signature, but nothing new is owed", status: r4 === "NotIncreasing" ? "ok" : "bad", value: r4 });
      }
    } catch (e) {
      push({ label: "Could not run the simulations", detail: errText(e), status: "bad" });
    }
    setRunning(false);
  }

  return (
    <section className="card">
      <h2>2 · Attack it yourself</h2>
      <p className="small">
        Each attack is an <code>eth_call</code> against the live escrow: nothing is signed with a funded key, nothing is sent, no gas is spent. The forged
        voucher is signed with a real ML-DSA-87 key made in this tab.
      </p>
      <button onClick={run} disabled={running || !live}>
        {running ? "Running…" : items.length ? "Run again" : "Run the attacks"}
      </button>
      {!live && channels && <p className="small">No open channel to target right now; the open-channel attack still needs one.</p>}
      <Checks items={items} />
    </section>
  );
}

// ------------------------------------------------------------------ 3. what happened on chain
function Proofs() {
  const [st, setSt] = useState<Record<string, ProofStatus | string>>({});
  useEffect(() => {
    PROOFS.forEach((p) =>
      proofStatus(p.hash)
        .then((s) => setSt((o) => ({ ...o, [p.hash]: s })))
        .catch((e) => setSt((o) => ({ ...o, [p.hash]: errText(e) }))),
    );
  }, []);
  return (
    <section className="card">
      <h2>3 · On the record</h2>
      <p className="small">
        Transactions from the recorded runs, re-read now from the chain's REST API. A refused agent action is included in a block with{" "}
        <code>success=false</code>: its nonce is used and no value moves.
      </p>
      <ul className="checks">
        {PROOFS.map((p) => {
          const s = st[p.hash];
          const ok = typeof s === "object" && (p.expect === "executed" ? s.executed : !s.executed);
          const cls = s === undefined ? "pending" : ok ? "ok" : "bad";
          return (
            <li key={p.hash} className={cls}>
              <span className="icon">{cls === "ok" ? "✓" : cls === "bad" ? "✗" : "…"}</span>
              <span>
                <b>{p.label}</b>
                <span className="small"> · {p.detail}</span>
                {typeof s === "object" && s.reason && (
                  <div className="reason">
                    chain: <code>{s.reason}</code>
                  </div>
                )}
                {typeof s === "string" && <div className="reason">{s}</div>}
              </span>
              <span className="val">
                {typeof s === "object" && (s.executed ? "executed" : "refused")} ·{" "}
                <a href={EXPLORER_TX + p.hash} target="_blank" rel="noreferrer">
                  {p.hash.slice(0, 10)}…
                </a>{" "}
                · <a href={DOC(p.source)}>doc</a>
              </span>
            </li>
          );
        })}
      </ul>
      <div className="note">
        The explorer opens on <b>mainnet</b>: click <b>Testnet</b> in its top bar once, then the links resolve. Links use the Cosmos hash because the explorer
        does not look up <code>0x</code> hashes.
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ 4. verify a voucher
function Verify() {
  const [raw, setRaw] = useState(VOUCHER_CLAUDE_SESSION);
  const [items, setItems] = useState<Check[]>([]);
  const [text, setText] = useState<string>();
  const [verdict, setVerdict] = useState<{ ok: boolean; msg: string }>();
  const [busy, setBusy] = useState(false);

  function tamper() {
    try {
      const v = parseVoucher(raw);
      setRaw(encodeVoucher(v.channelId, v.cumulative * 10n, v.signature));
      setItems([]);
      setVerdict(undefined);
      setText(undefined);
    } catch (e) {
      setVerdict({ ok: false, msg: errText(e) });
    }
  }

  async function check() {
    setBusy(true);
    setVerdict(undefined);
    setText(undefined);
    const out: Check[] = [];
    const push = (c: Check) => {
      out.push(c);
      setItems([...out]);
    };
    try {
      const v = parseVoucher(raw);
      const sigBytes = (v.signature.length - 2) / 2;
      push({ label: "Voucher parsed", detail: `${(Number(v.cumulative / PRICE_WEI)).toLocaleString()} calls at 0.001 QOR`, status: "ok", value: `channel ${v.channelId} · ${qor(v.cumulative)} · ${sigBytes} B signature` });
      const c = await readChannel(v.channelId);
      push({ label: "Channel read from the escrow", detail: channelState(c), status: "ok", value: `voucher signer ${short(c.voucherSigner)}` });

      const local = voucherText(v.channelId, c.provider, v.cumulative);
      const onChain = hexToString((await client.readContract({ address: LIVE.escrow, abi: escrowAbi, functionName: "voucherText", args: [v.channelId, v.cumulative] })) as Hex);
      setText(local);
      push({ label: "Signed text rebuilt in your browser = the contract's voucherText", status: local === onChain ? "ok" : "bad", value: local === onChain ? "byte-identical" : "differs" });

      const ks = await keyStatus(c.voucherSigner);
      push({ label: "Voucher signer's registered key", detail: "pqcKeyStatus", status: ks.ready ? "ok" : "bad", value: `ML-DSA-87 ${ks.keyBytes} B · possession ${ks.proven}` });
      const pinned = keccak256(ks.pubkey) === c.keyHash;
      push({ label: "It is the key pinned when the channel opened", status: pinned ? "ok" : "bad", value: pinned ? "keyHash matches" : "key rotated since open" });

      const valid = await pqcVerify(ks.pubkey, v.signature, qoreSignBytes(local));
      push({ label: "pqcVerify precompile 0x…0a01", detail: "the same check claim() runs", status: valid ? "ok" : "bad", value: String(valid) });
      setVerdict(
        valid
          ? { ok: true, msg: `Valid. The agent's ML-DSA-87 key signed "channel ${v.channelId}, ${qor(v.cumulative)} cumulative". The provider can claim up to this amount (capped at the deposit).` }
          : { ok: false, msg: "Invalid. The chain rejects this voucher: the signature does not match this channel and amount." },
      );
    } catch (e) {
      push({ label: "Could not check the voucher", detail: errText(e), status: "bad" });
    }
    setBusy(false);
  }

  return (
    <section className="card">
      <h2>4 · Verify a voucher</h2>
      <p className="small">
        A voucher is what the agent sends with every paid call, in the <code>x-tollgate-voucher</code> header:{" "}
        <code>&lt;channel&gt;.&lt;cumulative wei&gt;.&lt;base64 ML-DSA-87 signature&gt;</code>. It is cumulative, so the provider only ever needs the latest one.
        Both samples are real and already settled.
      </p>
      <label htmlFor="voucher">Voucher</label>
      <textarea id="voucher" value={raw} onChange={(e) => setRaw(e.target.value)} spellCheck={false} />
      <div>
        <button onClick={check} disabled={busy}>
          {busy ? "Checking…" : "Check on chain"}
        </button>
        <button className="ghost" onClick={() => (setRaw(VOUCHER_CLAUDE_SESSION), setItems([]), setVerdict(undefined), setText(undefined))}>
          Claude session (3 calls)
        </button>
        <button className="ghost" onClick={() => (setRaw(VOUCHER_1000_CALLS), setItems([]), setVerdict(undefined), setText(undefined))}>
          1,000-call run
        </button>
        <button className="ghost" onClick={tamper}>
          Tamper: amount × 10
        </button>
      </div>
      <Checks items={items} />
      {text && (
        <>
          <label>Signed bytes = "qorechain-msg-v1|qorechain-diana|" + </label>
          <pre>{text}</pre>
        </>
      )}
      {verdict && <div className={`verdict ${verdict.ok ? "ok" : "bad"}`}>{verdict.msg}</div>}
    </section>
  );
}

export function App() {
  const [channels, setChannels] = useState<Channel[]>();
  return (
    <main className="page">
      <header>
        <h1>Tollgate</h1>
        <p className="lead">
          Pay-per-call payment channels for AI agents on QoreChain. The agent pays each API call with an ML-DSA-87 voucher, off chain; the provider settles any
          number of calls with one claim. The owner's limits live on chain, so a prompt-injected model cannot override them.
        </p>
        <div className="links">
          <a href={REPO}>GitHub</a>
          <a href={VIDEO}>Video (2:38)</a>
          <a href={DOC("docs/TESTNET_RUN.md")}>Testnet run</a>
          <a href={DOC("docs/claude-session/README.md")}>Real Claude session</a>
          <a href={DOC("docs/THREAT_MODEL.md")}>Threat model</a>
        </div>
      </header>
      <section className="card flow">
        <h2>How it works</h2>
        <ol>
          <li>
            The <b>owner</b> approves a provider and the agent's voucher key with an <b>ML-DSA-87</b> signature, and sets a spending rule on their account
            (per-transaction and daily caps, only the escrow's channel calls allowed).
          </li>
          <li>
            The <b>agent</b> opens a channel through a linked key (<code>x/abstractaccount</code>, <code>MsgExecuteEVM</code>). The chain enforces the rule;
            the escrow only pays owner-approved providers.
          </li>
          <li>
            Every call carries a cumulative ML-DSA-87 voucher; every response carries an ML-DSA-87 receipt the agent verifies. <b>No transaction per call.</b>
          </li>
          <li>
            The <b>provider</b> claims with the latest voucher, checked by the <code>pqcVerify</code> precompile against the key pinned at open.
          </li>
        </ol>
      </section>
      <Escrow onChannels={setChannels} />
      <Attacks channels={channels} />
      <Proofs />
      <Verify />
      <footer>
        Read-only: this page holds no keys and sends no transactions. Testnet qorechain-diana. MIT. <a href={REPO}>Source</a>.
      </footer>
    </main>
  );
}
