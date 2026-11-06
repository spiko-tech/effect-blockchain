---
"@effect-blockchain/starknet": minor
---

Read the STRK balance of an address, in fri, at a block or sampled every `step` blocks.

- `StarknetRpc.call`: `starknet_call` at a block number, returning the raw felts, behind the head guard.
- `StarknetRpc.getBalance`: `balanceOf` on the STRK token, the u256 result as a `bigint`.
- `StarknetNetwork.strkToken`: the STRK token contract of each network.
- `StarknetIndexer.fetchNativeBalance` and `StarknetIndexer.streamNativeBalance`, with the `StarknetNativeBalance` and `StarknetIndexerNativeBalanceOptions` types.
- The `StarknetRpc` and `StarknetIndexer` services gain these members, so a hand-written implementation of either (a test fake) needs them too.
