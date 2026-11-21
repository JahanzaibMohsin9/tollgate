# Tollgate

[![Built on QoreChain](https://build.qorechain.io/badge/tollgate.svg)](https://build.qorechain.io/p/tollgate)

**Pay-per-call payment channels for AI agents on QoreChain, secured by ML-DSA-87.**

> Build Before Q-Day · Post-Quantum AI Agents track
>
> **Demo video (2:38):** https://youtu.be/kXrFDJ1bq_0

AI agents increasingly pay for APIs, data and inference **one call at a time**. Settling each call on chain is too expensive (PQ-402-style escrow costs about 253k gas *per request*), and handing an agent a normal wallet means trusting the model with your money.

Tollgate gives an agent a **payment channel** instead:
- The agent signs a **cumulative ML-DSA-87 voucher** for every call ("I have authorised at most N wei to this provider on this channel"). This happens off chain, costs no gas, and runs at about 16 calls per second.
- The provider settles **whenever it likes, with the latest voucher**. On testnet, **1,000 calls were settled with 2 claims of about 311k gas each**, one of them automatic.
- The agent **never holds the owner's keys**. It spends through a **linked ed25519 key** whose limits the **chain** enforces (QoreChain `x/abstractaccount`):
  - a per-transaction cap and a daily cap;
  - `uqor` only;
  - **only** the escrow's `open`, `topUp`, `startExit` and `finalizeExit` calls;
  - expiry after 7 days.
- **Recipients and voucher signers are owner-signed.** Spending rules cannot restrict recipients, so the escrow does: the owner approves each **(provider, voucher signer)** pair with an **ML-DSA-87 signature**. A prompt-injected model can neither pay an unapproved provider nor choose who signs its vouchers.
- **Earned vouchers can't be voided.** Claims verify against the voucher key **pinned at open**, so rotating the voucher account's key afterwards changes nothing.
- **Every response is signed.** The provider returns an **ML-DSA-87 receipt** binding the response body to the payment, which gives authenticated messaging both ways.
- **It plugs into AI tools.** An **MCP server** lets Claude, Cursor and other MCP clients use it through the tools `tollgate_open_channel`, `tollgate_fetch` and `tollgate_status`. The server knows only the owner's *address*.

## Proven live on testnet
Full run with every transaction linked: **[docs/TESTNET_RUN.md](docs/TESTNET_RUN.md)**

| What | Result on qorechain-diana |
|---|---|
| Agent opens a 1.5 QOR channel **as the owner's account** (`MsgExecuteEVM`, linked ed25519 key, relayer pays) | executed; the owner sent no EVM transaction and has no window |
| **1,000 paid API calls** | 62 s, **1000/1000 valid ML-DSA-87 receipts**, **0 transactions** |
| A model calling an unpaid route | nothing charged |
| Settlement | the provider claimed 600 calls in **one claim (about 311k gas)**, then **auto-claimed** the last 400 when the agent started the exit; **all 1,000 calls paid** |
| Prompt injection: "open a channel to the attacker" | **refused on chain by the escrow** (`ProviderNotAllowed`) even with budget left: the spending rule admits the call, the escrow reverts it (re-run, section 11) |
| A channel above the 2 QOR per-tx cap | **refused on chain**: "per-tx limit … exceeded" |
| The agent tries to approve the attacker itself | **refused on chain**: the call policy forbids `setProvider` |
| The provider forges a larger voucher | `WrongVoucherKey` |
| Exit | paid 1 + refunded 0.5 = deposit 1.5 ✓ |
| The same flow through **MCP** | open, 3 paid fetches with receipts verified; a 5 QOR attempt refused by the chain |
| **A real Claude session** (Sonnet 5.5, headless, Tollgate tools only) | the model **refused a hidden prompt injection** and reported it; its 5 QOR open was **refused by the chain**; it opened 0.2 QOR itself, paid 3 calls with verified receipts, and one claim settled them. **[Transcript](docs/claude-session/README.md)** |

## How the category requirements are met
| Requirement | Tollgate |
|---|---|
| **Smart-account spending rules** | `MsgUpdateSpendingRules` + `MsgRegisterAuthenticator` (one owner-signed tx): `perTxLimit` 2 QOR, `dailyLimit` 5 QOR, `allowedDenoms: [uqor]`, `allowedEvmCalls` = 4 escrow selectors. The agent spends through `MsgExecuteEVM`, using its own authenticator nonce (`/auth_nonce`). |
| **Scoped EVM window** | The provider settles inside a window with `allowedTargets=[escrow]`, 3 txs and a value cap. The owner never needs a window. |
| **Tx, value, duration and target limits** | Window: blocks (duration), max txs, max value, allowed targets. Rule: per-tx and daily value, call allowlist, key expiry. Escrow: deposit cap, approval deadline, challenge period (bounded from 1 minute to 30 days). |
| **Authenticated messaging** | ML-DSA-87 (QoreSign message-signing-v1) is used for agent vouchers, provider receipts and owner approvals. Every signed text is byte-identical to the contract's `voucherText` / `providerText`, checked live. |

## Engineering notes
- **37 Foundry tests with real ML-DSA-87** via [pqc-forge](https://github.com/JahanzaibMohsin9/pqc-forge):
  - every attack in the threat model;
  - all revert branches;
  - a conservation fuzz test;
  - a **stateful invariant suite**: paid ≤ deposit, paid only grows, the escrow holds exactly what is owed, and provider + refunds + balance = deposits.
- **Independent review.** After the first publish, an independent review found a high-severity issue (the payer could void earned vouchers by rotating the voucher key) plus several off-chain issues. All are fixed with regression tests; see [AI_USAGE.md](AI_USAGE.md).
- **Platform finding:** logs emitted inside x/abstractaccount `MsgExecuteEVM` are **not indexed by `eth_getLogs`** on qorechain-diana. Tollgate uses a `lastChannel` view and state polling instead of events.

## Repository
| Path | What |
|---|---|
| `src/ChannelEscrow.sol` | The escrow: owner ML-DSA approval of (provider, voucher signer), channels, pinned-key cumulative `claim`, exit with challenge period. |
| `test/` | Unit tests and the invariant suite. |
| `agent/src/agent.ts` | Agent client: `MsgExecuteEVM` through the linked key, voucher signing, receipt verification. |
| `agent/src/provider.ts` | Provider. It charges per call (402 without a voucher), signs receipts, persists vouchers and pinned keys, and polls state to auto-claim on exit. Demo endpoint: a Q-Day readiness oracle (`/v1/pq-status`). |
| `agent/src/mcp.ts` | MCP server (stdio). |
| `agent/scripts/live.ts`, `mcp-demo.ts` | The live testnet runs above. |
| `docs/THREAT_MODEL.md` | Threat model, including residual risks. |

## Run
```sh
git clone --recursive https://github.com/JahanzaibMohsin9/tollgate && cd tollgate
(cd lib/pqc-forge && npm ci) && forge test        # 37 tests incl. invariants, real ML-DSA-87
cd agent && npm ci && npm test   # offline tests: signed texts, provider persistence, agent totals
npm run live        # full testnet lifecycle (needs a funded RELAYER_MNEMONIC in agent/.env; other accounts are generated)
npm run mcp-demo    # the MCP flow
npm run demo        # short live run on an open channel: 120 paid calls, then ONE claim
npm run mcp-session # what a model sees over MCP (resumes the open channel)
```

### Use it from Claude (MCP)
The agent's `.env` should hold **only** the agent's keys (`TG_AGENT_ED25519`, `TG_VOUCHER_MNEMONIC`) and a relayer, never the owner's.
```json
{
  "mcpServers": {
    "tollgate": {
      "command": "node",
      "args": ["--import", "tsx", "--env-file=.env", "src/mcp.ts"],
      "cwd": "/path/to/tollgate/agent",
      "env": {
        "TG_OWNER_EVM": "0x8D1D8BCe31cd200587Ec853D10aB5aF45699459A",
        "TOLLGATE_ESCROW": "0xc764e126ab277f9a1b46d45101a2f1cf7bcdc408",
        "TOLLGATE_PROVIDER": "0xb518Ae67AE27122D4314366cC58F18813dc88868",
        "TOLLGATE_PROVIDER_URL": "http://127.0.0.1:8787",
        "TOLLGATE_PRICE_WEI": "1000000000000000"
      }
    }
  }
}
```

## Live contracts (qorechain-diana)
| | Address |
|---|---|
| ChannelEscrow | `0xc764e126ab277f9a1b46d45101a2f1cf7bcdc408` |
| Owner (payer) | `0x8D1D8BCe31cd200587Ec853D10aB5aF45699459A` |
| Provider | `0xb518Ae67AE27122D4314366cC58F18813dc88868` |
| Agent voucher account | `0xC76b568737A209161D24317D66b42551749DE243` |

## Credits
- [pqc-forge](https://github.com/JahanzaibMohsin9/pqc-forge): real ML-DSA-87 in Foundry, plus the `PQSig` library.
- `@qorechain/sdk`, `@qorechain/evm`, `@qorechain/pqc`, OpenZeppelin Contracts v5.4.0, forge-std, the Model Context Protocol SDK, viem and @noble/curves.
- Native-lane broadcast pattern adapted from qorechain/build-before-qday (Apache-2.0).
- Pay-per-call over HTTP 402 is also explored by PQ-402. Tollgate's vouchers settle *many* calls per claim.

MIT licence.
