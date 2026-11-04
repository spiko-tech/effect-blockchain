---
"@effect-blockchain/evm": patch
---

Adds `EvmIndexer`, a raw log indexer on top of `EvmRpc`: the last confirmed block and the logs of a set of contracts over any block range.

- Adds `EvmIndexer.layer({ confirmations?, maxBlockRange? })`, requiring `EvmRpc`: `lastConfirmedBlock` is the head minus the confirmations, never below 0, and `fetchLogs(filter)` splits `[fromBlock, toBlock]` into chunks of at most `maxBlockRange` blocks (`DEFAULT_MAX_BLOCK_RANGE`, 1000), one `eth_getLogs` per chunk, sequential, concatenated in chain order. It fails with `EvmRpcError`.
- Adds `EvmNetwork.defaultConfirmations(network)`: Ethereum 64, Polygon 32, Base 30, Arbitrum 240, Etherlink 20, Optimism 30, Avalanche 1, BNB Smart Chain 50, Gnosis 32, Linea 30, testnets as their mainnet.
- Breaking: `EvmLogsFilter.address: EvmAddress | ReadonlyArray<EvmAddress>` becomes `addresses: NonEmptyReadonlyArray<EvmAddress>`, always sent as the JSON-RPC `address` array. Replace `{ address: token }` with `{ addresses: [token] }`.
