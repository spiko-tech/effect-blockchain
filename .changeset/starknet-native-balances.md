---
"@effect-blockchain/starknet": minor
---

Read native balances at many blocks in one call

- `StarknetIndexer.fetchNativeBalances({ address, blocks, concurrency?, retry? })` returns the STRK balances in the order of `blocks`, with one `balanceOf` call per distinct block and none for an empty `blocks`. `concurrency` is 1 by default.
- `StarknetIndexer.fetchNativeBalance` reads through `fetchNativeBalances` with one block.
