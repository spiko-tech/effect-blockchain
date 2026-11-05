---
"@effect-blockchain/stellar": patch
---

Adds `StellarIndexer.streamEvents`, a stream of confirmed contract events that follows the latest ledger from a ledger.

- Adds `streamEvents({ filter, fromBlock, toBlock?, pollInterval?, retry? })`: one `StellarIndexerBatch` per step, up to `maxBlockRange` confirmed ledgers, emitted even without events, built on `fetchEvents` (contract id groups, cursor paging, restart once, events of failed calls dropped). Caught up, it waits `pollInterval` and reads the latest ledger again; with `toBlock` it ends after the batch reaching it. With `retry`, a step failing with `Unavailable`, `InvalidResponse` or `Lagging` is retried at the same ledger; any other failure, or an exhausted schedule, fails the stream. At-least-once: the caller saves `batch.toBlock` after handling a batch.
- `Pruned` fails the stream at once, retry or not: RPC nodes keep about 7 days of ledgers, so the caller restarts from a newer `fromBlock`.
- Adds the `StellarIndexerBatch` model: `{ fromBlock, toBlock, events }`.
- Adds `DEFAULT_POLL_INTERVAL`, 10 seconds.
