---
"@effect-blockchain/evm": patch
---

Breaking: `EvmRpcError.reason` is now a core `JsonRpc.Reason` (a tagged error) instead of a string literal.

- `EvmRpcErrorReason` is removed: match on `error.reason._tag`, or use `Effect.catchReason("EvmRpcError", "Pruned", f)`.
- A `WrongNetwork` reason carries the `expected` and `actual` network identifiers, `Unavailable` the HTTP status when there is one.
- The error `message` and `code` are unchanged.
- `EvmIndexer` retries with core's `JsonRpc.isTransient`, same reasons as before.
