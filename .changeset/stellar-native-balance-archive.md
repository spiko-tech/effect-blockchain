---
"@effect-blockchain/stellar": minor
---

Read the ledgers of a past native balance from the archive endpoints directly

- `StellarIndexer.fetchNativeBalance` takes `archive`: each ledger that changed the account is read from the endpoints flagged `archive` only, and the read fails `Rejected` when no endpoint is flagged `archive`. The account entry stays on the regular endpoints. Off by default.
- `StellarIndexerNativeBalanceOptions` takes the same `archive`, for the first sample of `StellarIndexer.streamNativeBalance`.
