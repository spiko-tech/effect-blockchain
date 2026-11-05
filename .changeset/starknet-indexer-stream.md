---
"@effect-blockchain/starknet": patch
---

Adds `StarknetIndexer.streamEvents`, a stream of confirmed events that follows the head from a block.

- Adds `streamEvents({ filter, fromBlock, toBlock?, pollInterval?, retry? })`: one `StarknetIndexerBatch` per step, up to `maxBlockRange` confirmed blocks, emitted even without events, built on `fetchEvents` (chunks, cursor paging and the chunk restart unchanged). Caught up, it waits `pollInterval` and reads the head again; with `toBlock` it ends after the batch reaching it. With `retry`, a step failing with `Unavailable`, `InvalidResponse` or `Lagging`, including a cursor page still failing after the chunk restart, is retried at the same block; any other failure, or an exhausted schedule, fails the stream. At-least-once: the caller saves `batch.toBlock` after handling a batch.
- Adds the `StarknetIndexerBatch` model: `{ fromBlock, toBlock, events }`.
- Adds `DEFAULT_POLL_INTERVAL`, 10 seconds.
