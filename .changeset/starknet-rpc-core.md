---
"@effect-blockchain/starknet": patch
---

`StarknetRpc` now runs on the shared `@effect-blockchain/core` JSON-RPC engine. Its API is unchanged.

- Moved to `JsonRpc`: the HTTP pipeline, retries with `Retry-After`, the attempt timeout, URL-free causes, spans, the cached network check, fallback, the head guard, cursor routing.
- Stays in `StarknetRpc`: the error class, the code table (63, -32603, -32005, 429 → `Unavailable`; 24, 29 → `Lagging`), the `starknet_chainId` network check, the `getEvents` checks (out-of-filter events, cursor building).
- `StarknetRpcError`, `StarknetRpcErrorReason`, the layer options and their defaults and every method signature stay the same.
- The endpoint URL stays `Redacted` until each request.
- Adds `@effect-blockchain/core` as a dependency.
