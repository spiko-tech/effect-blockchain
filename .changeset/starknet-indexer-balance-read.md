---
"@effect-blockchain/starknet": patch
---

Keep `StarknetRpc` to standard JSON-RPC methods.

- Remove `StarknetRpc.getBalance`: `StarknetIndexer.fetchNativeBalance` and `streamNativeBalance` read STRK `balanceOf` over `StarknetRpc.call` and decode the u256 themselves.
- A `balanceOf` reply that is not two felts fails with a `StarknetRpcError` (`InvalidResponse`, endpoint `StarknetIndexer`) and is not retried on the next endpoint.
