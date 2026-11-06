---
"@effect-blockchain/core": patch
---

Record JSON-RPC metrics with `effect/Metric`, exported from `JsonRpc` and free when nobody reads them. Attributes hold the endpoint name, never its URL.

- `JsonRpc.requests` (`effect_blockchain_rpc_requests_total`, counter): one per request to an endpoint, its HTTP retries included, by `network`, `endpoint`, `method` and `outcome` (`success` or the reason tag).
- `JsonRpc.requestDuration` (`effect_blockchain_rpc_request_duration`, timer in milliseconds): the duration of the same requests, same attributes.
- `JsonRpc.fallbacks` (`effect_blockchain_rpc_fallbacks_total`, counter): one each time a call moves to the next endpoint, by `network`, `endpoint` (the one that failed), `method` and `outcome` (the reason tag that caused it).
