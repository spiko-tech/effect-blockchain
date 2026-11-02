---
"@effect-blockchain/evm": patch
---

`EvmRpc` now sends its requests through the Effect `HttpClient` instead of viem's `http` transport (viem 2.57.11 stays for the primitives).

- `EvmRpc.layer` now requires `HttpClient.HttpClient` (e.g. `FetchHttpClient.layer`). The `fetch` option is removed: provide `FetchHttpClient.Fetch` instead.
- Retries use `HttpClient.retryTransient`: transport errors, timeouts, HTTP 408/429/500/502/503/504 and the JSON-RPC codes -32005, -32603, -32007, -1 and 429, with an exponential, jittered backoff from `retryDelay` (default now 500 millis, was 150) honoring `Retry-After`.
- HTTP 403 and 413 are no longer retried: they stay `Unavailable` and move to the next endpoint at once.
- A non-JSON or empty body is now `InvalidResponse`.
