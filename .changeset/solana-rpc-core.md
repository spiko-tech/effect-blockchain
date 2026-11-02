---
"@effect-blockchain/solana": patch
---

`SolanaRpc` now runs on the shared `@effect-blockchain/core` JSON-RPC engine. Its API is unchanged.

- Moved to `JsonRpc`: the HTTP pipeline, retries with `Retry-After`, the attempt timeout, URL-free causes, spans, the cached network check, fallback.
- Stays in `SolanaRpc`: the error class, the code table with its codes (429, -32603, -32005, -32019 `Unavailable`; -32016, -32004, -32014 `Lagging`; -32001, -32007, -32009, -32011, -32010 `Pruned`), the `getGenesisHash` network check, the exact `bigint` body parsing and the `getTransaction` `null` check (`Pruned`).
- `SolanaRpcError`, `SolanaRpcErrorReason`, the layer options and their defaults and every method signature stay the same.
- The endpoint URL stays `Redacted` until each request.
- Adds `@effect-blockchain/core` as a dependency.
