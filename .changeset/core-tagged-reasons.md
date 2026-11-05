---
"@effect-blockchain/core": patch
---

Breaking: `JsonRpc.Reason` is now a union of tagged errors, matched with `Effect.catchReason` / `Effect.catchReasons`.

- New reason classes: `Unavailable { status? }` (HTTP status when there is one), `InvalidResponse`, `Lagging { head?, toBlock? }` (set by the head guard, unset for a `Lagging` JSON-RPC code), `Pruned`, `Rejected`, `WrongNetwork { expected, actual }`.
- New `JsonRpc.isTransient(reason)`: true for `Unavailable`, `InvalidResponse` and `Lagging`.
- `Options.codes` now maps a code to a `JsonRpc.CodeReason` tag (any reason but `WrongNetwork`); the engine builds the reason. `ErrorFields.reason` and `JsonRpc.fail` take a reason instance.
- `withFallback` is a recursion instead of a loop; same behaviour: stops on `WrongNetwork`, one error as is, several as the last one with an `AggregateError` cause.
