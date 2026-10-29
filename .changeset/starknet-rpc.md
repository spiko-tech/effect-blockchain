---
"@effect-blockchain/starknet": patch
---

Add `StarknetRpc`: typed, read-only `starknet_chainId`, `starknet_blockNumber`, `starknet_getEvents` (one page, with an endpoint-bound cursor) and `starknet_getTransactionReceipt` over an ordered list of endpoints with fallback, network check and head guard, on `effect/http` `HttpClient`, and the `StarknetEvent` schema.
