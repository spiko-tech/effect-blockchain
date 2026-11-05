---
"@effect-blockchain/stellar": patch
---

Breaking: `StellarRpcError.reason` is now a core `JsonRpc.Reason` (a tagged error) instead of a string literal.

- `StellarRpcErrorReason` is removed: match on `error.reason._tag`, or use `Effect.catchReason("StellarRpcError", "Pruned", f)`.
- A `WrongNetwork` reason carries the `expected` and `actual` network identifiers, `Unavailable` the HTTP status when there is one.
- The error `message` and `code` are unchanged.
- `StellarIndexer` retries with core's `JsonRpc.isTransient`, same reasons as before.
- A `Lagging` reason from the head guard, the `getEvents` page check or the out-of-range start error carries `head` and `toBlock`.
