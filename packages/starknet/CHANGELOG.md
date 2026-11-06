# @effect-blockchain/starknet

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
