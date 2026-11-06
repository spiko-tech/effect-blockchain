---
"@effect-blockchain/core": minor
---

Initial release.

- `JsonRpc`: the shared JSON-RPC engine behind the chain packages, with ordered endpoints and fallback.
- Typed error reasons shared by every chain: `Unavailable`, `InvalidResponse`, `Lagging`, `Pruned`, `Rejected`, `WrongNetwork`.
- `isTransient` to retry only the failures a later attempt can fix.
- RPC metrics for every call.
