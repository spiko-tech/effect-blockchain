---
"@effect-blockchain/evm": patch
---

Adds `EvmIndexer.streamLogs`, a stream of confirmed logs that follows the head from a block.

- Adds `streamLogs({ filter, fromBlock, toBlock?, pollInterval?, retry? })`: one `EvmIndexerBatch` per step, up to `maxBlockRange` confirmed blocks, emitted even without logs, built on `fetchLogs`. Caught up, it waits `pollInterval` and reads the head again; with `toBlock` it ends after the batch reaching it. With `retry`, a step failing with `Unavailable`, `InvalidResponse` or `Lagging` is retried at the same block; any other failure, or an exhausted schedule, fails the stream. At-least-once: the caller saves `batch.toBlock` after handling a batch.
- Adds the `EvmIndexerBatch` model: `{ fromBlock, toBlock, logs }`.
- Adds `DEFAULT_POLL_INTERVAL`, 10 seconds.
