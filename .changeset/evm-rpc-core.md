---
"@effect-blockchain/evm": patch
---

`EvmRpc` now runs on the shared `@effect-blockchain/core` JSON-RPC engine. Its API is unchanged.

- Moved to `JsonRpc`: the HTTP pipeline, retries with `Retry-After`, the attempt timeout, URL-free causes, spans, the cached network check, fallback, the head guard.
- Stays in `EvmRpc`: the error class, the code table with its codes (-32005, -32603, -32007, -1 and 429 as `Unavailable`), the `eth_chainId` network check, the `eth_blockNumber` head tracking and the `eth_getLogs` checks and order.
- `EvmRpcError`, `EvmRpcErrorReason`, the layer options and their defaults and every method signature stay the same.
- The endpoint URL stays `Redacted` until each request.
- Adds `@effect-blockchain/core` as a dependency.
