# Tollgate

**Pay-per-call payment channels for AI agents on QoreChain, secured by ML-DSA-87.**

> Build Before Q-Day · Post-Quantum AI Agents track

AI agents increasingly pay for APIs, data and inference **one call at a time**. Settling each call on chain is too expensive (PQ-402-style escrow costs about 253k gas *per request*), and handing an agent a normal wallet means trusting the model with your money.

Tollgate gives an agent a **payment channel** instead:
- The agent signs a **cumulative ML-DSA-87 voucher** for every call ("I have authorised at most N wei to this provider"). This happens off chain, costs no gas, and runs at about 20 calls per second.
- The provider settles **once**, with the latest voucher. **1,000 calls cost one transaction of about 270k gas**, measured on testnet.
- The agent **never holds the owner's keys**. It spends through a **linked ed25519 key** whose limits the **chain** enforces (QoreChain `x/abstractaccount`):
  - a per-transaction cap and a daily cap;
  - `uqor` only;
  - **only** the escrow's `open`, `topUp`, `startExit` and `finalizeExit` calls;
  - expiry after 7 days.
- **Recipients are owner-signed.** Spending rules cannot restrict recipients, so the escrow does: a channel can only be opened to a provider the owner allowlisted with an **ML-DSA-87 signature**, which a prompt-injected model cannot produce.
- **Every response is signed.** The provider returns an **ML-DSA-87 receipt** binding the response body to the payment, which gives authenticated messaging both ways.
- **It plugs into AI tools.** An **MCP server** lets Claude, Cursor and other MCP clients use it directly, through the tools `tollgate_open_channel`, `tollgate_fetch` and `tollgate_status`.

## Proven live on testnet
Full run with every transaction linked: **[docs/TESTNET_RUN.md](docs/TESTNET_RUN.md)**

| What | Result on qorechain-diana |
|---|---|
| Agent opens a 1.5 QOR channel **as the owner's account** (`MsgExecuteEVM`, linked ed25519 key, relayer pays) | executed; the owner sent no EVM transaction |
| **1,000 paid API calls** | 45.8 s, **1000/1000 valid ML-DSA-87 receipts**, **0 transactions** |
| Settle all 1,000 calls | **one `claim`, about 270,087 gas** |
| Prompt injection: "open a channel to the attacker" | **refused on chain** (`ProviderNotAllowed`) |
| A channel above the 2 QOR per-tx cap | **refused on chain**: "per-tx limit … exceeded" |
| The agent tries to allowlist the attacker itself | **refused on chain**: the call policy forbids `setProvider` |
| The provider forges a larger voucher | `InvalidSignature` |
| Exit after the challenge period | paid 1 + refunded 0.5 = deposit 1.5 ✓ |
| The same flow through **MCP** | open, 3 paid fetches with receipts verified; a 5 QOR attempt was refused by the chain |

## How the category requirements are met
| Requirement | Tollgate |
|---|---|
| **Smart-account spending rules** | `MsgUpdateSpendingRules` + `MsgRegisterAuthenticator` (one owner-signed tx): `perTxLimit` 2 QOR, `dailyLimit` 3 QOR, `allowedDenoms: [uqor]`, `allowedEvmCalls` = 4 escrow selectors. The agent spends through `MsgExecuteEVM`, using its own authenticator nonce (`/auth_nonce`). |
| **Scoped EVM window** | The provider settles inside a window with `allowedTargets=[escrow]`, 2 txs and a value cap. The owner never needs a window at all. |
| **Tx, value, duration and target limits** | Window: blocks (duration), max txs, max value, allowed targets. Rule: per-tx and daily value, call allowlist, key expiry. Escrow: deposit cap and challenge period. |
| **Authenticated messaging** | ML-DSA-87 (QoreSign message-signing-v1) is used for agent vouchers, provider receipts and owner provider-allowlist messages. Every signed text is byte-identical to the contract's own `voucherText` / `providerText`, checked live. |

## Repository
| Path | What |
|---|---|
| `src/ChannelEscrow.sol` | The escrow: owner ML-DSA provider allowlist, channels, cumulative-voucher `claim`, exit with challenge period. |
| `test/ChannelEscrow.t.sol` | **22 tests with real ML-DSA-87** via [pqc-forge](https://github.com/JahanzaibMohsin9/pqc-forge), including a fuzz test that funds are conserved. |
| `agent/src/agent.ts` | Agent client: `MsgExecuteEVM` through the linked key, voucher signing, receipt verification. |
| `agent/src/provider.ts` | Provider: an HTTP API that charges per call (402 without a voucher), signs receipts, settles once. Demo endpoint: a Q-Day readiness oracle (`/v1/pq-status`). |
| `agent/src/mcp.ts` | MCP server (stdio). |
| `agent/scripts/live.ts`, `mcp-demo.ts` | The live testnet runs above. |
| `docs/THREAT_MODEL.md` | Threat model, including the residual risks. |

## Run
```sh
git clone --recursive https://github.com/JahanzaibMohsin9/tollgate && cd tollgate
(cd lib/pqc-forge && npm ci) && forge test        # 22 tests, real ML-DSA-87
cd agent && npm ci
npm run live        # full testnet lifecycle (needs a funded RELAYER_MNEMONIC in agent/.env; other accounts are generated)
npm run mcp-demo    # the MCP flow
```

### Use it from Claude (MCP)
```json
{
  "mcpServers": {
    "tollgate": {
      "command": "node",
      "args": ["--import", "tsx", "--env-file=.env", "src/mcp.ts"],
      "cwd": "/path/to/tollgate/agent",
      "env": {
        "TOLLGATE_ESCROW": "0x5cfa8786857f5de735dcc3f5aceedc1b510559df",
        "TOLLGATE_PROVIDER": "0xe6b0F5298a556217fbEbe257c9964AB34B5961a5",
        "TOLLGATE_PROVIDER_URL": "http://127.0.0.1:8787"
      }
    }
  }
}
```

## Live contracts (qorechain-diana)
| | Address |
|---|---|
| ChannelEscrow | `0x5cfa8786857f5de735dcc3f5aceedc1b510559df` |
| Owner (payer) | `0xBa24644656600Fc27b7c0e9b688B3FDA062ad6f4` |
| Provider | `0xe6b0F5298a556217fbEbe257c9964AB34B5961a5` |
| Agent voucher account | `0xc3Ee0d5780a0b60d2Ff97CeBd815A6942027B101` |

## Credits
- [pqc-forge](https://github.com/JahanzaibMohsin9/pqc-forge): real ML-DSA-87 in Foundry, plus the `PQSig` library.
- `@qorechain/sdk`, `@qorechain/evm`, `@qorechain/pqc`, OpenZeppelin Contracts v5.4.0, forge-std, the Model Context Protocol SDK, viem and @noble/curves.
- Native-lane broadcast pattern adapted from qorechain/build-before-qday (Apache-2.0).
- Pay-per-call over HTTP 402 is also explored by PQ-402. Tollgate's vouchers settle *many* calls in one claim.

MIT licence.
