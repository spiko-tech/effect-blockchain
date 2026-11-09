# @effect-blockchain/starknet

## 0.2.0

### Minor Changes

- [#66](https://github.com/spiko-tech/effect-blockchain/pull/66) [`d02c4bf`](https://github.com/spiko-tech/effect-blockchain/commit/d02c4bfa8f5a8b10836008817db0603821a76796) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - Read the STRK balance of an address, in fri, at a block or sampled every `step` blocks.
  
  - `StarknetRpc.call`: `starknet_call` at a block number, returning the raw felts, behind the head guard.
  - `StarknetNetwork.STRK_TOKEN_ADDRESS`: the STRK token contract, the same on mainnet and Sepolia.
  - `StarknetIndexer.fetchNativeBalance` and `StarknetIndexer.streamNativeBalance`, with the `StarknetNativeBalance` and `StarknetIndexerNativeBalanceOptions` types.
  - The `StarknetRpc` and `StarknetIndexer` services gain these members, so a hand-written implementation of either (a test fake) needs them too.

### Patch Changes

- [#70](https://github.com/spiko-tech/effect-blockchain/pull/70) [`9614244`](https://github.com/spiko-tech/effect-blockchain/commit/961424422c9873a1c55e2c227947d5f3668a38d3) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - Keep `StarknetRpc` to standard JSON-RPC methods.
  
  - Remove `StarknetRpc.getBalance`: `StarknetIndexer.fetchNativeBalance` and `streamNativeBalance` read STRK `balanceOf` over `StarknetRpc.call` and decode the u256 themselves.
  - A `balanceOf` reply that is not two felts fails with a `StarknetRpcError` (`InvalidResponse`, endpoint `StarknetIndexer`) and is not retried on the next endpoint.

## 0.1.0

### Minor Changes

- [#58](https://github.com/spiko-tech/effect-blockchain/pull/58) [`b21f4e0`](https://github.com/spiko-tech/effect-blockchain/commit/b21f4e0c73c66efdcd796b98f21dd378357665b0) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - Initial release.
  
  - `StarknetRpc`: typed, read-only Starknet JSON-RPC methods over an ordered list of endpoints with fallback.
  - `StarknetIndexer`: the last confirmed block, the events of a contract over a block range, and a stream of them following the confirmed head.
  - `StarknetNetwork`: named Starknet networks and their chain IDs.
  - Schemas for `StarknetAddress`, `StarknetBlock`, `StarknetEvent` and `StarknetTransactionHash`, built on starknet.js.

### Patch Changes

- Updated dependencies [[`b21f4e0`](https://github.com/spiko-tech/effect-blockchain/commit/b21f4e0c73c66efdcd796b98f21dd378357665b0)]:
  - @effect-blockchain/core@0.1.0
