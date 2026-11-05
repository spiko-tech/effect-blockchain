---
"@effect-blockchain/solana": patch
---

Adds `SolanaIndexer.streamTransactions`, a stream of finalized transactions that follows the head from a slot.

- Adds `streamTransactions({ filter, fromBlock, toBlock?, pollInterval?, retry? })`: a step pages the signatures of `[next, lastConfirmedBlock]` like `fetchTransactions`, cuts them into groups of at most `maxBatchSize` signatures without splitting a slot, then each following step fetches one group with `getTransaction` and emits it as one `SolanaIndexerBatch`. The batch bounds tile the range; a range without signatures is one empty batch. Caught up, it waits `pollInterval` and reads the head again; with `toBlock` it ends after the batch reaching it. With `retry`, a step (the signature paging or one group) failing with `Unavailable`, `InvalidResponse` or `Lagging` is retried at the same position; any other failure, or an exhausted schedule, fails the stream. At-least-once: the caller saves `batch.toBlock` after handling a batch.
- Adds the `SolanaIndexerBatch` model: `{ fromBlock, toBlock, transactions }`.
- Adds the `maxBatchSize` layer option and `DEFAULT_MAX_BATCH_SIZE`, 100, and `DEFAULT_POLL_INTERVAL`, 10 seconds.
- `fetchTransactions` is unchanged: it shares the signature paging and the `getTransaction` calls with the stream.
