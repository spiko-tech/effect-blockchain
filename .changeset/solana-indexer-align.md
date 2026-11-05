---
"@effect-blockchain/solana": patch
---

Aligns `SolanaIndexer` with the other chain indexers.

- `layer` takes its options as optional: `SolanaIndexer.layer()` builds with the network's default confirmations.
- Adds `SolanaIndexerFilter`, the named type of the `fetchTransactions` filter.
- `fetchTransactions` pages `getSignaturesForAddress` with `Stream.paginate`, same stop rule.
- Adds the `SolanaIndexer.lastConfirmedBlock` tracing span.
