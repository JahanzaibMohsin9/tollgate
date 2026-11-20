# Tollgate threat model

## Assets
- The **owner's funds**, held in the owner's QoreChain account.
- **Channel deposits**, held in `ChannelEscrow`.
- The **provider's earnings**: the latest voucher it holds that is not yet settled.

## Keys and who holds them
| Key | Holder | Can do | Cannot do |
|---|---|---|---|
| Owner ML-DSA-87 + secp256k1 | the human (wallet) | everything; link and revoke the agent key; allowlist providers | – |
| Agent ed25519 (linked authenticator) | the agent process | `MsgExecuteEVM` as the owner, **only** `open` / `topUp` / `startExit` / `finalizeExit` on the escrow, within the per-tx and daily caps, until expiry | call any other contract; allowlist a provider; exceed the caps; touch the owner's keys |
| Agent ML-DSA-87 voucher key | the agent process | authorise payments from *its own channels* up to their deposit | move anything else |
| Provider ML-DSA-87 | the provider | sign receipts; claim its own channels | claim more than a voucher allows |
| Relayer | anyone | submit and pay fees | change what was signed (the digest binds to, value, data, gas and nonce) |

## Threats and mitigations
| # | Threat | Mitigation | Evidence |
|---|---|---|---|
| T1 | **Prompt injection**: the model is told to pay an attacker | The escrow only opens channels to providers the owner allowlisted with an **ML-DSA-87 signature**; the agent cannot produce that signature. | Live: `open(attacker)` refused (`ProviderNotAllowed`). Test: `test_promptInjectedAgentCannotOpenToAttacker`. |
| T2 | The agent tries to allowlist the attacker itself | The call policy (`allowedEvmCalls`) excludes `setProvider`. Even if it were listed, the owner's ML-DSA signature is required. | Live: refused by the call policy. Test: `test_agentOrAttackerCannotAllowlistAProvider`. |
| T3 | The agent overspends | Chain-enforced `perTxLimit` (2 QOR) and `dailyLimit` (3 QOR); the deposit caps every channel. | Live: 2.5 QOR and 5 QOR (via MCP) refused, "per-tx limit exceeded". |
| T4 | The provider overcharges | It can only settle a voucher the agent signed, for at most the deposit; vouchers are bound to chain, escrow, channel and provider. | Tests: forged, tampered, wrong-channel and above-deposit vouchers all fail. Live: forged voucher gives `InvalidSignature`. |
| T5 | The provider replays an old voucher | Claims must strictly increase the cumulative amount. The HTTP API refuses vouchers that are not above the last one. | Test: `test_olderVoucherCannotBeSettledAgain`. Live: replay gives HTTP 402. |
| T6 | The voucher key is swapped after opening | `keccak(pubkey)` is pinned at `open`; a changed key gives `VoucherKeyChanged`. | Test: `test_voucherKeyIsPinnedAtOpen`. |
| T7 | A copied public key is registered under another address | `PQSig.registeredKey` requires `possessionProven`. | Test: `test_openRequiresVoucherKeyWithPossessionProof`. |
| T8 | The provider disappears and funds lock up | The payer can `startExit`; after the challenge period anyone can `finalizeExit`, which refunds the remainder. | Live: refund 0.5 QOR. Test: `test_silentProviderGetsNothingAfterExit`. |
| T9 | The payer exits to cheat the provider | The provider keeps the full challenge period to claim its latest voucher. | Test: `test_exitLetsProviderClaimThenRefundsRest`. |
| T10 | Q-Day: secp256k1 / ed25519 keys are broken | Vouchers, receipts and allowlist messages are all ML-DSA-87. The owner's account needs a hybrid signature. The agent's ed25519 key is a bounded, expiring, revocable sub-key. | Design. |
| T11 | The precompile is unavailable (mainnet today) | `PQSig` fails closed: it requires exactly 32 bytes back and reverts otherwise. | Test: `test_failsClosedWithoutPrecompiles`. |
| T12 | The response is tampered or spoofed | Every response carries an ML-DSA-87 receipt over `sha256(body)`, channel and cumulative amount. | Live: 1000/1000 receipts verified. |
| T13 | Reentrancy on claim or refund | `nonReentrant`; state is updated before transfers. | Code. |

## Residual risks (stated honestly)
1. **Plain value transfers by a compromised agent key.** QoreChain spending rules cannot restrict *recipients*, and a rule-bound key may still send plain value. A fully compromised agent key could send up to the per-tx cap per transaction and the daily cap per day to any address. This was demonstrated live with 0.01 QOR. **The damage is bounded by the caps.** Mitigations: keep the caps small; keep only an operating float in the owner account; revoke the key (`MsgRevokeAuthenticator`) on any anomaly. The chain also forces a re-link within 30 days.
2. **The provider is trusted for service quality.** Receipts prove *what* it answered, not that the answer is correct. Keep per-call prices small and channel deposits short-lived.
3. **The provider takes up to one call of credit**: the agent signs before it receives the response. Exposure is the price of one call.
4. **Availability:** the provider must claim before an exit completes. Default challenge period: set per deployment (120 s in the demo; use hours in production).
5. **Mainnet:** `abstractaccount` and the PQC precompiles are **testnet-only today**, and enabling them needs governance. Tollgate fails closed without them.
