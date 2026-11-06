---
"@effect-blockchain/evm": minor
---

Initial release.

- `EvmRpc`: typed, read-only EVM JSON-RPC methods (`eth_chainId`, `eth_blockNumber`, `eth_getBlockByNumber`, `eth_getLogs`) over an ordered list of endpoints with fallback.
- `EvmIndexer`: the last confirmed block, the logs of a set of contracts over a block range, and a stream of them following the confirmed head.
- `EvmNetwork`: named EVM networks and their chain IDs.
- Schemas for `EvmAddress`, `EvmBlock`, `EvmLog`, `EvmHexData` and `EvmTransactionHash`, built on viem.
