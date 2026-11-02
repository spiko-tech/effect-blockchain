---
"@effect-blockchain/stellar": patch
---

Align `StellarRpc` with the shared RPC rules.

- `StellarEventsCursor` is now a branded `Schema.Struct({ endpoint, cursor })` (category `schemas`), it was a `Brand.nominal` type.
- The JSON-RPC internal error `-32603` is now retried like transient HTTP errors before failing `Unavailable` and falling back.
- Errors from the HTTP client keep only their reason and status: the transport error's cause, which can carry the URL, is dropped.
- `getEvents` returns an empty page for an empty range before looking at the cursor.
- A malformed cursor now fails `Rejected` instead of dying.
