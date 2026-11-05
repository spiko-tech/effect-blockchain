---
"@effect-blockchain/stellar": patch
---

Aligns `StellarIndexer` with the other chain indexers.

- Breaking: renames `StellarIndexer.defaultMaxBlockRange` to `StellarIndexer.DEFAULT_MAX_BLOCK_RANGE` (same value, 10000).
- `layer` now requires `maxBlockRange` to be a safe integer (`Number.isSafeInteger`, was `Number.isInteger`), dying with a `RangeError` otherwise.
- `fetchEvents` pages each contract-id group with `Stream.paginate`. Same behaviour: a failed cursor page restarts the group once from its first page.
- Adds tracing spans: `StellarIndexer.lastConfirmedBlock` and `StellarIndexer.fetchEvents`.
