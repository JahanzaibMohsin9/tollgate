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

## Mistakes the process caught
- A **BigInt serialisation crash** in the live script; the run was resumable, so no transactions were wasted.
- The prompt-injection refusal showed a generic reason, so it was confirmed with `eth_call` (`ProviderNotAllowed`) instead of being assumed.
