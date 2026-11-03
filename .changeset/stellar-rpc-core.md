---
"@effect-blockchain/stellar": patch
---

`StellarRpc` now runs on the shared `@effect-blockchain/core` JSON-RPC engine. Its API is unchanged.

- Moved to `JsonRpc`: the HTTP pipeline, retries with `Retry-After`, the attempt timeout, URL-free causes, spans, the cached network check, fallback, cursor routing.
- Stays in `StellarRpc`: the error class, the code table with its codes (`-32603` is `Unavailable`), the `getNetwork` passphrase check, the `getHealth` retention guard (`Lagging`, `Pruned`), the out-of-range mapping and the `getEvents` checks.
- `StellarRpcError`, `StellarRpcErrorReason`, the layer options and their defaults and every method signature stay the same.
- The endpoint URL stays `Redacted` until each request.
- Adds `@effect-blockchain/core` as a dependency.
