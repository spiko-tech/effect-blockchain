---
"@effect-blockchain/stellar": patch
---

`StellarRpc` falls back on a timeout instead of retrying it.

- A timed-out attempt is no longer retried on the same endpoint: it fails `Unavailable` at once and the call moves to the next endpoint. Transport errors, HTTP 408/429/5xx and `-32603` are still retried.
