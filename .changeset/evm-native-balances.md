---
"@effect-blockchain/evm": minor
---

Read native balances at many blocks in one call

- `EvmIndexer.fetchNativeBalances({ address, blocks, concurrency?, retry? })` returns the balances in the order of `blocks`, with one `eth_getBalance` per distinct block and none for an empty `blocks`. `concurrency` is 1 by default.
- `EvmIndexer.fetchNativeBalance` reads through `fetchNativeBalances` with one block.
