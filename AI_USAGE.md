# AI usage

Built with **Claude Code** (Anthropic) as a pair programmer. A human developer chose the direction, made the decisions and reviewed the work.

## Workflow
1. **Idea selection with independent AI reviews.** Three rounds, each with two separately prompted reviewers: a jury perspective, and an engineer who read the chain's source code and probed the live testnet. They scored candidate ideas against the real competition and the chain's real capabilities. Tollgate began as a rollup design. The reviewers showed that QoreChain's rollup ledger can't express its fraud proofs, so it was rebuilt as EVM payment channels.
2. **Code** (escrow, tests, agent, provider, MCP server): drafted with AI, reviewed by a human, and tested with **real ML-DSA-87** (pqc-forge), never mocked hashes.
3. **Every chain assumption was verified live**, not taken from memory or docs:
   - account-abstraction message shapes (from the SDK types);
   - the chain's refusal messages (from real transactions);
   - text parity between client and contract (`eth_call`);
   - gas (`eth_estimateGas`).

## AI-generated vs human
| Part | AI | Human |
|---|---|---|
| Architecture (channels + allowlist + linked key) | proposed | chose, and accepted the trade-offs (residual risks) |
| Solidity and tests | drafted | reviewed; ran the live runs |
| Agent, provider, MCP (TypeScript) | drafted | reviewed; tested with MCP |
| Threat model | drafted from test and live evidence | reviewed |

## Independent review of the published code, and what it changed
After the first publish, two separately prompted AI reviewers audited the repository: a jury perspective, and a security engineer who wrote proof-of-concept tests. Their findings, all fixed with regression tests:
- **High (TG-1):** the payer could rotate the voucher account's ML-DSA key after receiving service, void every earned voucher and exit with a full refund. Claims now verify against the key **pinned at open** (passed in calldata, checked against its hash).
- **A prompt-injected agent could name the provider as its own voucher signer.** The owner's ML-DSA approval now binds the (provider, voucher signer) pair, and approvals carry a deadline.
- **Off chain:**
  - the provider cached channel state forever and kept vouchers only in memory;
  - the agent advanced its total on unpaid routes;
  - the MCP server loaded the owner's mnemonic.

  All are fixed: periodic state refresh, persisted vouchers and pinned keys, totals that advance only on consumption, and an address-only owner.

The re-run on testnet then surfaced a **platform finding**: logs emitted inside x/abstractaccount `MsgExecuteEVM` are not indexed by `eth_getLogs`. An event-based exit watcher missed an exit, and 0.4 QOR of vouchers went unclaimed in that run. The watcher now polls channel state; the report shows the corrected run.

## Mistakes the process caught
- A **BigInt serialisation crash** in the live script; the run was resumable, so no transactions were wasted.
- The prompt-injection refusal showed a generic reason, so it was confirmed with `eth_call` (`ProviderNotAllowed`) instead of being assumed.
