---
"@effect-blockchain/starknet": patch
---

Breaking: `StarknetRpcError.reason` is now a core `JsonRpc.Reason` (a tagged error) instead of a string literal.

- `StarknetRpcErrorReason` is removed: match on `error.reason._tag`, or use `Effect.catchReason("StarknetRpcError", "Pruned", f)`.
- A `WrongNetwork` reason carries the `expected` and `actual` network identifiers, `Unavailable` the HTTP status when there is one.
- The error `message` and `code` are unchanged.
- `StarknetIndexer` retries with core's `JsonRpc.isTransient`, same reasons as before.
