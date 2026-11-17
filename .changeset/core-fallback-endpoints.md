---
"@effect-blockchain/core": minor
---

The `JsonRpc` engine can restrict a call to some of its endpoints.

- The engine exposes its `endpoints`, and `withFallback(f, only)` takes an optional non-empty subset of them, tried in the order given. Both are for the chain packages.
