---
"@effect-blockchain/evm": minor
---

Read the native balance (wei) of an address at a block.

- `EvmRpc.getBalance({ address, blockNumber })` over `eth_getBalance`, only answered by an endpoint whose head has reached the block. Past blocks need archive endpoints.
- `EvmIndexer.fetchNativeBalance({ address, block })` and `EvmIndexer.streamNativeBalance({ address, fromBlock, toBlock?, step, poll?, retry? })`, a sample every `step` blocks following the confirmed head.
- New `EvmNativeBalance` and `EvmIndexerNativeBalanceOptions` types.

The `EvmRpc` and `EvmIndexer` services gain members, so a hand-written fake of either service (`EvmRpc.of(...)`, `EvmIndexer.of(...)`) needs `getBalance`, `fetchNativeBalance` and `streamNativeBalance` entries.
