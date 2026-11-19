---
"@effect-blockchain/solana": minor
---

Page consecutive ranges from a signature cursor

- `SolanaIndexer.fetchTransactionBatch` returns the transactions of `fetchTransactions` with a `SolanaSignatureCursor`: the last signature of each full `getSignaturesForAddress` page read above the range. Passed to the call over the next range, it starts the listing below its lowest entry above that range instead of at the head, so a backfill in ascending ranges no longer reads every newer page again for each range.
- A cursor never changes the transactions returned: entries at or below `toBlock` and cursors of another address are ignored, and when the node answers the starting signature with an empty page (unknown or pruned), the range is listed from the head again.
