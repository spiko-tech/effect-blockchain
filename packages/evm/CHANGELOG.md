# @effect-blockchain/evm

## 0.2.0

### Minor Changes

- [#63](https://github.com/spiko-tech/effect-blockchain/pull/63) [`200541c`](https://github.com/spiko-tech/effect-blockchain/commit/200541cc2260b87c4d725a73c2a5cdd4b2393f09) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - Add the Anvil local network (chain ID 31337).
  
  `EvmNetwork` gains the `"Anvil"` literal, so an exhaustive `Record<EvmNetwork, ...>` in caller code needs an `Anvil` entry.

## 0.1.0

### Minor Changes

- [#58](https://github.com/spiko-tech/effect-blockchain/pull/58) [`b21f4e0`](https://github.com/spiko-tech/effect-blockchain/commit/b21f4e0c73c66efdcd796b98f21dd378357665b0) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - Initial release.
  
  - `EvmRpc`: typed, read-only EVM JSON-RPC methods (`eth_chainId`, `eth_blockNumber`, `eth_getBlockByNumber`, `eth_getLogs`) over an ordered list of endpoints with fallback.
  - `EvmIndexer`: the last confirmed block, the logs of a set of contracts over a block range, and a stream of them following the confirmed head.
  - `EvmNetwork`: named EVM networks and their chain IDs.
  - Schemas for `EvmAddress`, `EvmBlock`, `EvmLog`, `EvmHexData` and `EvmTransactionHash`, built on viem.

### Patch Changes

- Updated dependencies [[`b21f4e0`](https://github.com/spiko-tech/effect-blockchain/commit/b21f4e0c73c66efdcd796b98f21dd378357665b0)]:
  - @effect-blockchain/core@0.1.0
