---
"@effect-blockchain/stellar": minor
---

Read past native balances by hopping back through the ledgers that changed the account

- `StellarIndexer.fetchNativeBalance` reads the account entry at the head, then the `getLedgers` meta of each ledger that changed the account after `block`, one ledger per request, instead of every ledger since `block`. The first sample of `streamNativeBalance` reads the same way.
- `fetchNativeBalance` fails `InvalidResponse` when a ledger does not change the account its entry names, or names a later previous change.
- `fetchNativeBalance` and `fetchEvents` take `retry`, which retries each request that failed with a transient reason. It is off by default.
