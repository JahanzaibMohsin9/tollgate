# Tollgate threat model

## Assets
- The **owner's funds**, held in the owner's QoreChain account.
- **Channel deposits**, held in `ChannelEscrow`.
- The **provider's earnings**: signed vouchers it has not settled yet.

## Keys and who holds them
| Key | Holder | Can do | Cannot do |
|---|---|---|---|
| Owner ML-DSA-87 + secp256k1 | the human (wallet) | everything; link and revoke the agent key; approve (provider, voucher signer) pairs | – |
| Agent ed25519 (linked authenticator) | the agent process | `MsgExecuteEVM` as the owner, **only** `open` / `topUp` / `startExit` / `finalizeExit` on the escrow, within the per-tx and daily caps, until expiry | call anything else; approve a provider; pick the voucher signer; exceed the caps; touch the owner's keys |
| Agent ML-DSA-87 voucher key | the agent process | authorise payments from *its own channels* up to their deposit | move anything else |
| Provider ML-DSA-87 | the provider | sign receipts; claim its own channels | claim more than a voucher allows |
| Relayer | anyone | submit and pay fees | change what was signed (the digest binds to, value, data, gas and nonce) |

The MCP server (`agent/src/mcp.ts`) is given the owner's **address only** (`TG_OWNER_EVM`). It refuses to start rather than generate keys when configuration is missing.

## Threats and mitigations
| # | Threat | Mitigation | Evidence |
|---|---|---|---|
| T1 | **Prompt injection**: the model is told to pay an attacker | Channels can only be opened to providers the owner approved with an **ML-DSA-87 signature**; the agent cannot produce one. | Live: `open(attacker)` refused (`ProviderNotAllowed`). Test: `test_promptInjectedAgentCannotOpenToAttacker`. |
| T2 | The agent tries to approve the attacker itself | The call policy (`allowedEvmCalls`) excludes `setProvider`, and an approval needs the owner's ML-DSA signature anyway. | Live: refused by the call policy. Test: `test_agentOrAttackerCannotApproveAProvider`. |
| T3 | **The agent picks a malicious voucher signer**, e.g. the provider itself, which could then sign and claim the whole deposit | The owner's approval binds **(provider, voucher signer)**; `open(provider)` takes the approved signer and the agent cannot choose it. | Tests: `test_voucherSignerIsTheOwnerApprovedOne`, `test_approvalBindsTheVoucherSigner`. |
| T4 | The agent overspends | Chain-enforced `perTxLimit` and `dailyLimit`; the deposit caps every channel. | Live: 2.5 QOR refused ("per-tx limit exceeded"); MCP 5 QOR refused. |
| T5 | **The payer rotates or deregisters the voucher key after receiving service** to void earned vouchers, then exits for a full refund | Claims verify against the key **pinned at open**: the key is passed in calldata and must match the stored hash, so registry changes after open are irrelevant. The provider caches and persists the pinned key from the first voucher it verifies. | Tests: `test_keyRotationCannotStrandEarnedVouchers`, `test_deregistrationCannotStrandEarnedVouchers`, `test_vouchersByARotatedKeyAreRejected`. |
| T6 | The provider overcharges | It can only settle a voucher the agent signed, for at most the deposit; vouchers bind chain, escrow, channel and provider. | Tests: forged, tampered and wrong-channel vouchers fail. Live: forged voucher gives `WrongVoucherKey`. |
| T7 | Replay of an old voucher | Claims must increase what is paid. The HTTP API refuses vouchers that are not above the last one. | Test: `test_olderVoucherCannotBeSettledAgain`. Live: replay gives HTTP 402. |
| T8 | A stale owner approval is relayed much later | Approvals carry a `valid until` deadline and a sequential nonce; revoke by approving `voucherSigner = 0`. | Tests: `test_staleApprovalExpires`, `test_approvalCannotBeReplayed`, `test_ownerCanRevokeProvider`. |
| T9 | A copied public key is registered under another address | `PQSig.registeredKey` requires `possessionProven`. | Test: `test_openRequiresVoucherKeyWithPossessionProof`. |
| T10 | The payer exits to cheat the provider | The provider keeps the challenge period to claim; ties at `exitAt` favour the provider. The provider **polls the state of every channel it holds vouchers for and auto-claims** as soon as an exit starts. | Live run, step 9 (auto-claim). Tests: `test_exitLetsProviderClaimThenRefundsRest`, `test_claimAtExactExitAtStillWorks`. |
| T11 | The provider disappears and funds lock up | The payer can `startExit`; after the challenge period anyone can `finalizeExit`, which refunds the remainder. | Live refund. Test: `test_silentProviderGetsNothingAfterExit`. |
| T12 | The provider restarts and loses vouchers | Vouchers and pinned keys are written to disk **before** each response is sent. | Code (`vouchersPath`). |
| T13 | The model calls an **unpaid route** and gets charged | The agent only advances its total when the provider confirms it consumed that exact voucher (`x-tollgate-cumulative`); the MCP tool only allows `/v1/` paths. | Live: `/health` charged nothing. |
| T14 | Response tampering or spoofing | ML-DSA-87 receipt over `sha256(body)`, channel and cumulative amount. The MCP tool reports an unverified receipt as **not ok**. | Live: 1000/1000 receipts verified. |
| T15 | Q-Day: secp256k1 / ed25519 keys broken | Vouchers, receipts and approvals are all ML-DSA-87. The owner's account needs hybrid signatures. The agent's ed25519 key is a bounded, expiring, revocable sub-key. | Design. |
| T16 | The precompile is unavailable (mainnet today) | `PQSig` fails closed. | Test: `test_failsClosedWithoutPrecompiles`. |
| T17 | Reentrancy, truncation | `nonReentrant`, state changed before transfers, `SafeCast`, a bounded challenge period. | Tests: `test_revertingPayerOnlyBlocksItsOwnRefund`, `test_challengePeriodIsBounded`. |
| T18 | Funds are not conserved | Stateful invariants: paid ≤ deposit, paid only grows, escrow balance = deposit − paid for an open channel, provider + refunds + balance = all deposits. | `ChannelEscrow.invariant.t.sol` (64 runs × 64 calls = 4,096 calls, real ML-DSA). |

## Residual risks (stated honestly)
1. **Plain value transfers by a compromised agent key.** QoreChain spending rules cannot restrict *recipients*, and a rule-bound key may still send plain value. A fully compromised agent key can send up to the per-tx cap per transaction and the daily cap per day to any address. This was demonstrated live with 0.01 QOR, and **it is bounded by the caps**. Mitigations: keep the caps small; keep an operating float in the owner account; revoke the key on any anomaly. The chain also forces a re-link within 30 days.
2. **The provider is trusted for service quality.** Receipts prove *what* it answered, not that the answer is correct. Keep prices small and deposits short-lived.
3. **The provider takes up to one call of credit**: the agent signs before it receives the response.
4. **Availability:** the provider must be online during the challenge period (auto-claim). Use hours in production; the demo uses 120 s.
5. **Platform finding:** logs emitted inside x/abstractaccount `MsgExecuteEVM` are **not indexed by `eth_getLogs`** on qorechain-diana today. Tollgate does not depend on them: it uses the `lastChannel` view and state polling.
6. **Mainnet:** `abstractaccount` and the PQC precompiles are **testnet-only today**, and enabling them needs governance. Tollgate fails closed without them.
