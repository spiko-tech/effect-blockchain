---
"@effect-blockchain/stellar": patch
---

Add `StellarRpc`: typed, read-only `getNetwork`, `getLatestLedger` and `getEvents` (one page, endpoint-bound cursor) over an ordered list of endpoints with fallback, network check and ledger guard, on `effect/http` `HttpClient`, and the `StellarContractEvent` schema.
