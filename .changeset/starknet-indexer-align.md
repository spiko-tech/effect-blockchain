---
"@effect-blockchain/starknet": patch
---

Aligns `StarknetIndexer` with the other chain indexers.

- `layer` dies with a `RangeError` when `maxBlockRange` is not a positive safe integer (0 used to fail later on a BigInt division by zero).
- Adds tracing spans: `StarknetIndexer.lastConfirmedBlock` and `StarknetIndexer.fetchEvents`.
