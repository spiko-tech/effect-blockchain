---
"@effect-blockchain/solana": minor
---

Retry transient failures in every `SolanaIndexer` fetch

- `SolanaIndexer.fetchTransactions`, `SolanaIndexer.fetchTransactionBatch` and `SolanaIndexer.fetchNativeBalance` take `retry` in their options. It retries each `getSignaturesForAddress` page, `getTransaction`, `getBalance` or `getSlot` failing with a transient reason (`JsonRpc.isTransient`), so a retry keeps the pages and transactions already read. It is off by default.
- The JSDoc of the three methods states their request cost.
