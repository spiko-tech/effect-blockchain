---
"@effect-blockchain/solana": patch
---

`SolanaRpc` sends its requests through the provided `HttpClient`.

- `SolanaRpc.layer` now requires `HttpClient.HttpClient` (e.g. `FetchHttpClient.layer`). `@solana/kit`'s HTTP transport and the global `fetch` are no longer used.
- Replies are still read with every JSON integer as an exact `bigint`, through an internal `JSON.parse` reviver (Node >= 24).
- Retries use `HttpClient.retryTransient`: transport errors, timeouts, HTTP 408/429/500/502/503/504 and the `Unavailable` JSON-RPC codes are retried, honoring `Retry-After`. Any other HTTP status falls back at once.
- A non-JSON body fails with `InvalidResponse`.
- Error causes keep the HTTP error kind and status only, never the URL. The HTTP client span is disabled.
