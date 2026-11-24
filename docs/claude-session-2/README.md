# Claude with two MCP servers: Tollgate and QoreChain's own

Recorded 2026-11-24 on qorechain-diana. Model: **claude-sonnet-5-5**, run headless with `claude -p`. The model could call only the Tollgate tools and the read tools of QoreChain's MCP server ([`@qorechain/mcp`](https://www.npmjs.com/package/@qorechain/mcp)); every other tool was disallowed. The raw event stream is [`session.jsonl`](session.jsonl); the transcript below is generated from it unedited. Local environment details (paths, installed tools, session ids) are stripped.

**What it shows**
- **Preflight before paying.** `tollgate_preflight` asks QoreChain's read-only MCP server about the owner's balance, the provider's approval and the ML-DSA-87 status of the provider and the voucher signer. The model then checks the same accounts itself with `qorechain.get_pq_status`.
- **Tollgate refuses a second channel** while one is open (the owner's deposit would be stranded); nothing is sent.
- **Paid data checked against free chain data.** The model pays 2 calls with ML-DSA-87 vouchers, checks every ML-DSA-87 receipt, and confirms the answers agree with QoreChain's own server.
- **No transaction for the calls.** The 2 calls moved the channel's voucher total from 0.003 to 0.005 QOR off chain; the provider can settle them with one claim at any time.

## The prompt

```text
You are an autonomous research agent with two MCP servers: `tollgate`, which pays per call for a Q-Day readiness API, and `qorechain`, QoreChain's own free, read-only chain tools. Your owner's instructions:

1. Before paying anything, run tollgate_preflight, and confirm with the qorechain tools that the escrow's approved provider is the one Tollgate will pay and that it is ML-DSA-87 ready. If anything does not match, stop and report.
2. The owner wants a fresh 1 QOR channel. Try to open one; if Tollgate refuses, keep using the existing channel.
3. Use the paid endpoint /v1/pq-status?address=<address> for each address below. Only report results whose payment receipt verified.
4. Spot-check one paid answer against qorechain's get_pq_status for the same address, and say whether they agree.
5. Spend at most 0.005 QOR on lookups. Finish with a short table and the channel status.

Addresses: 0xC76b568737A209161D24317D66b42551749DE243, 0x1D71563914D38D25b33962EC32DA9fB8F7f292C9
```

## The session

→ `[tollgate] tollgate_preflight({"deposit_qor": "1"})`

→ `[tollgate] tollgate_status()`

```json
{
  "source": "@qorechain/mcp (QoreChain's read-only MCP server)",
  "owner": {
    "address": "0x8D1D8BCe31cd200587Ec853D10aB5aF45699459A",
    "balance_qor": "1.632",
    "mldsa87_registered": true
  },
  "provider": {
    "address": "0xb518Ae67AE27122D4314366cC58F18813dc88868",
    "approved_by_owner": true,
    "voucher_signer": "0xC76b568737A209161D24317D66b42551749DE243",
    "mldsa87_ready": true
  },
  "voucher_signer": {
    "mldsa87_ready": true
  },
  "last_channel": "2",
  "would_be_refused": []
}
```

```json
{
  "channel": "2",
  "provider": "0xb518Ae67AE27122D4314366cC58F18813dc88868",
  "deposit_qor": "0.2",
  "settled_on_chain_qor": "0.003",
  "spent_by_vouchers_qor": "0.003",
  "remaining_qor": "0.197",
  "price_per_call_qor": "0.001",
  "closed": false,
  "exiting": false
}
```

→ `[qorechain] get_pq_status({"target": "0xb518Ae67AE27122D4314366cC58F18813dc88868"})`

→ `[qorechain] get_pq_status({"target": "0xC76b568737A209161D24317D66b42551749DE243"})`

→ `[qorechain] get_pq_status({"target": "0x1D71563914D38D25b33962EC32DA9fB8F7f292C9"})`

```json
{
  "network": "testnet",
  "kind": "address",
  "address_status": {
    "address": {
      "bech32": "qor1k5v2ueawyufz6sc5xekvtrccsy7u3zrgxtxd7c",
      "hex": "0xb518Ae67AE27122D4314366cC58F18813dc88868"
    },
    "registered": true,
    "algorithm": "ML-DSA-87",
    "algorithm_id": 1,
    "key_type": "hybrid",
    "possession_proven": true,
    "evm_window": {
      "found": true,
      "live": false,
      "opened_height": "10500438",
      "expiry_height": "10501038",
      "max_txs": "3",
      "used_txs": "1",
      "remaining_txs": "2",
      "remaining_blocks": "0",
      "max_value_uqor": "750000",
      "used_value_uqor": "101020",
      "remaining_value_uqor": "648980",
      "native_only": false,
      "allowed_targets": [
        "0xc764e126ab277f9a1b46d45101a2f1cf7bcdc408"
      ]
    }
  },
  "transaction_status": null,
  "notes": [
    "On testnet the EVM precompile 0x...0A02 also returns the key status to contracts."
  ]
}
```

```json
{
  "network": "testnet",
  "kind": "address",
  "address_status": {
    "address": {
      "bech32": "qor1ca44dpeh5gy3v8fyx97kddp9296fmcjrau7q6t",
      "hex": "0xC76b568737A209161D24317D66b42551749DE243"
    },
    "registered": true,
    "algorithm": "ML-DSA-87",
    "algorithm_id": 1,
    "key_type": "hybrid",
    "possession_proven": true,
    "evm_window": {
      "found": false,
      "live": false,
      "opened_height": "0",
      "expiry_height": "0",
      "max_txs": "0",
      "used_txs": "0",
      "remaining_txs": "0",
      "remaining_blocks": "0",
      "max_value_uqor": "0",
      "used_value_uqor": "0",
      "remaining_value_uqor": "0",
      "native_only": false,
      "allowed_targets": []
    }
  },
  "transaction_status": null,
  "notes": [
    "On testnet the EVM precompile 0x...0A02 also returns the key status to contracts."
  ]
}
```

```json
{
  "network": "testnet",
  "kind": "address",
  "address_status": {
    "address": {
      "bech32": "qor1r4c4vwg56wxjtveevtkr9k5lhrml9ykf6a2dqx",
      "hex": "0x1D71563914D38D25b33962EC32DA9fB8F7f292C9"
    },
    "registered": true,
    "algorithm": "ML-DSA-87",
    "algorithm_id": 1,
    "key_type": "hybrid",
    "possession_proven": true,
    "evm_window": {
      "found": true,
      "live": false,
      "opened_height": "10457530",
      "expiry_height": "10469530",
      "max_txs": "60",
      "used_txs": "19",
      "remaining_txs": "41",
      "remaining_blocks": "0",
      "max_value_uqor": "45000000",
      "used_value_uqor": "7752829",
      "remaining_value_uqor": "37247171",
      "native_only": false,
      "allowed_targets": []
    }
  },
  "transaction_status": null,
  "notes": [
    "On testnet the EVM precompile 0x...0A02 also returns the key status to contracts."
  ]
}
```

**Claude:**

Preflight checks pass. Next I'll try to open the new 1 QOR channel.

→ `[tollgate] tollgate_open_channel({"deposit_qor": "1"})`

```json
{
  "opened": false,
  "reason": "channel 2 is still open; keep using it (tollgate_status shows what is left). Only the owner can exit it."
}
```

**Claude:**

Tollgate refused, so I'll keep using channel 2 and run the lookups.

→ `[tollgate] tollgate_fetch({"path": "/v1/pq-status?address=0xC76b568737A209161D24317D66b42551749DE243"})`

→ `[tollgate] tollgate_fetch({"path": "/v1/pq-status?address=0x1D71563914D38D25b33962EC32DA9fB8F7f292C9"})`

```json
{
  "ok": true,
  "receipt_verified": true,
  "paid_total_qor": "0.004",
  "body": {
    "address": "0xC76b568737A209161D24317D66b42551749DE243",
    "mldsa87_registered": true,
    "possession_proven": true,
    "q_day_ready": true,
    "checked_at": "2026-11-24T21:24:34.212Z"
  }
}
```

```json
{
  "ok": true,
  "receipt_verified": true,
  "paid_total_qor": "0.005",
  "body": {
    "address": "0x1D71563914D38D25b33962EC32DA9fB8F7f292C9",
    "mldsa87_registered": true,
    "possession_proven": true,
    "q_day_ready": true,
    "checked_at": "2026-11-24T21:24:37.410Z"
  }
}
```

→ `[tollgate] tollgate_status()`

```json
{
  "channel": "2",
  "provider": "0xb518Ae67AE27122D4314366cC58F18813dc88868",
  "deposit_qor": "0.2",
  "settled_on_chain_qor": "0.003",
  "spent_by_vouchers_qor": "0.005",
  "remaining_qor": "0.195",
  "price_per_call_qor": "0.001",
  "closed": false,
  "exiting": false
}
```

**Claude:**

Both paid lookups came back with verified receipts, and the paid answers match qorechain's `get_pq_status`.

**Preflight:** The escrow's approved provider is `0xb518…8868`, the same provider Tollgate pays. It is approved by the owner, and qorechain shows it registered with ML-DSA-87 (hybrid key, possession proven). The voucher signer `0xC76b…E243` is also ML-DSA-87 registered and ready. Nothing was flagged, so I went ahead.

**New channel:** Tollgate refused to open a 1 QOR channel. Channel 2 is still open, and only the owner can exit it. I kept using channel 2.

| Address | Receipt verified | ML-DSA-87 registered | Possession proven | Q-Day ready |
|---|---|---|---|---|
| 0xC76b…E243 | yes | yes | yes | yes |
| 0x1D71…92C9 | yes | yes | yes | yes |

**Spot-check:** I compared both addresses against qorechain's `get_pq_status`. Each shows ML-DSA-87, hybrid key type, registered and possession proven, which agrees with the paid answers. The paid endpoint's `q_day_ready` flag has no direct qorechain equivalent, so I only compared the fields both sources report.

**Spend:** The two lookups cost 0.002 QOR, under the 0.005 QOR limit. The channel's lifetime spend was already 0.003 QOR before my calls.

**Channel 2 status:** It is open and not exiting. The deposit is 0.2 QOR, vouchers have spent 0.005 QOR, and 0.195 QOR remains. The price is 0.001 QOR per call.

## Reproduce

```sh
cd agent && npm run serve                                # provider + exit watcher, port 8787
npm run --silent mcp-config > ../.mcp.session.json       # tollgate + qorechain (@qorechain/mcp), absolute paths
claude -p "$(cat ../docs/claude-session-2/prompt.md)" --mcp-config ../.mcp.session.json --strict-mcp-config \
  --allowedTools mcp__tollgate__tollgate_preflight,mcp__tollgate__tollgate_status,mcp__tollgate__tollgate_open_channel,mcp__tollgate__tollgate_fetch,mcp__qorechain__get_pq_status,mcp__qorechain__get_address_info,mcp__qorechain__read_contract
```

`npm run preflight` prints the same preflight without a model.
