---
"@effect-blockchain/stellar": minor
---

Read native balances at many ledgers in one walk

- `StellarIndexer.fetchNativeBalances` returns the native balance of an account at the end of each of `blocks`, in the order of `blocks`. It costs the requests of a single `fetchNativeBalance` at the lowest block, whatever the number of blocks, and none for an empty `blocks`. It takes `archive` and `retry` like `fetchNativeBalance`.
- `StellarIndexer.fetchNativeBalance` reads through the same walk with one block.
