---
"@effect-blockchain/core": patch
---

Add the private `@effect-blockchain/core` package with `JsonRpc`, the JSON-RPC engine the chain RPC modules will share.

- `JsonRpc.make` takes the chain's `network`, `endpoints`, `timeout`, `retries` and `retryDelay` (defaults 30 seconds, 3, 500 millis), its `codes` table, an optional `parseBody`, its `checkNetwork` and its `makeError`.
- It holds the shared rules of the four chain modules: `HttpClient` pipeline with `retryTransient` honoring `Retry-After`, `AttemptTimeout` (a timed-out attempt is not retried and falls back), URL-free causes, one span per request, a network check cached per endpoint, ordered fallback with an `AggregateError` cause, the head guard and cursor routing (`endpointOf`).
- No chain package uses it yet.
