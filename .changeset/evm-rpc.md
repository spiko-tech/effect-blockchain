---
"@effect-blockchain/evm": patch
---

Add `EvmRpc`: typed, read-only `eth_chainId`, `eth_blockNumber` and `eth_getLogs` over an ordered list of endpoints with fallback, network check and head guard, and the `EvmLog` schema.
