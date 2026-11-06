---
"@effect-blockchain/starknet": patch
---

Breaking: `StarknetIndexer.streamEvents` takes a `poll` schedule instead of `pollInterval`.

- `pollInterval?: Duration.Input` is replaced by `poll?: Schedule.Schedule<unknown>`, default `Schedule.spaced(DEFAULT_POLL_INTERVAL)` (10 seconds, unchanged). Migrate `pollInterval: "1 minute"` to `poll: Schedule.spaced("1 minute")`.
- Caught up, the stream reads the head again on `poll` until it reaches the next block, then fetches as before. The schedule starts afresh after each batch, so a backoff (e.g. `Schedule.exponential`) resets after progress.
- A bounded `poll` that is exhausted while still caught up ends the stream without error: `Schedule.recurs(0)` drains to the head and stops.
- `retry` still wraps one step: a transient head failure while polling is retried at the same position with `retry`, and fails the stream without it.
