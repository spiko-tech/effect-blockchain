---
"@effect-blockchain/stellar": minor
---

Index the native (XLM) balance of an account.

- `StellarIndexer.fetchNativeBalance({ address, block })`: the balance in stroops at the end of a ledger.
- `StellarIndexer.streamNativeBalance({ address, fromBlock, toBlock?, step, poll?, retry? })`: a `StellarNativeBalance` sample every `step` ledgers, following the confirmed head.
- `StellarRpc.getLedgers` (ledger metas, raw base64 XDR, falling back from `Pruned` to an archive endpoint) and `StellarRpc.getLedgerEntries` (raw base64 entries at the head, failing `Lagging` below `minLedger`).
- History is read from the ledger metas of `getLedgers`, 1 to 3 MB per mainnet ledger: `step` does not reduce these reads.
- An account missing at the head reads `0` at every ledger, even if it was merged later.
- The `StellarRpc` service gains `getLedgers` and `getLedgerEntries`: a hand-written `StellarRpc` implementation (a test fake, for example) needs both.
