---
"@effect-blockchain/stellar": patch
---

`StellarIndexer.streamEvents` reads the confirmed head once per catch-up.

- The stream position keeps the last confirmed ledger read: a step whose next ledger is at or below it fetches the next batch directly, and `lastConfirmedBlock` is read only when the stream reaches that ledger. A catch-up over N batches makes one `getLatestLedger` call where it made N.
- Batches, `toBlock`, `poll`, `retry` and spans are unchanged.
