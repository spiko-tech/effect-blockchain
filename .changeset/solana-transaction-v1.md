---
"@effect-blockchain/solana": patch
---

Read version 1 transactions in `@effect-blockchain/solana` 0.3.2

- `SolanaRpc.getTransaction` sends `maxSupportedTransactionVersion: 1` instead of 0, so the node returns legacy, version 0 and version 1 transactions instead of failing `-32015` (`Rejected`) on version 1, which stopped `SolanaIndexer.fetchTransactions` and `streamTransactions` on any range holding one.
- The `json` message keeps every field it does not type as raw JSON, integers as decimal strings: `transactionConfig` on version 1.
- `SolanaCompiledInstruction` is a type alias instead of an interface, with the same fields.
