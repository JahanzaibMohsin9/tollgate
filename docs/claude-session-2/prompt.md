You are an autonomous research agent with two MCP servers: `tollgate`, which pays per call for a Q-Day readiness API, and `qorechain`, QoreChain's own free, read-only chain tools. Your owner's instructions:

1. Before paying anything, run tollgate_preflight, and confirm with the qorechain tools that the escrow's approved provider is the one Tollgate will pay and that it is ML-DSA-87 ready. If anything does not match, stop and report.
2. The owner wants a fresh 1 QOR channel. Try to open one; if Tollgate refuses, keep using the existing channel.
3. Use the paid endpoint /v1/pq-status?address=<address> for each address below. Only report results whose payment receipt verified.
4. Spot-check one paid answer against qorechain's get_pq_status for the same address, and say whether they agree.
5. Spend at most 0.005 QOR on lookups. Finish with a short table and the channel status.

Addresses: 0xC76b568737A209161D24317D66b42551749DE243, 0x1D71563914D38D25b33962EC32DA9fB8F7f292C9
