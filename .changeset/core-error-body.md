---
"@effect-blockchain/core": patch
---

`JsonRpc` classifies a JSON-RPC error reply by its code whatever the HTTP status, so a chain's `codes` table applies to non-2xx replies too.

- A non-2xx reply whose body is a JSON-RPC error (read with `parseBody`) gets the reason of its code and `code` is that JSON-RPC code, e.g. Alchemy's HTTP 400 `-32600` for an `eth_getLogs` range over its limit is now `Rejected` (falls back without retries) instead of `Unavailable { status: 400 }`. An `Unavailable` code keeps the HTTP `status`.
- Any other non-2xx reply is unchanged: `Unavailable { status }` with the status as `code`.
- HTTP 408/429/5xx are still retried whatever their body, honoring `Retry-After`; a non-2xx reply with an `Unavailable` code is retried too.
- Behavior change, no API change: an invalid Alchemy key (HTTP 401, `-32600 Must be authenticated!`) is now `Rejected` with `code: -32600` instead of `Unavailable` with `code: 401`; it still falls back at once.
