---
"@effect-blockchain/stellar": minor
---

Read old native balances from the endpoints flagged `archive`

- `StellarIndexer.fetchNativeBalance` and `streamNativeBalance` read a `getLedgers` page again from the endpoints flagged `archive` when the regular endpoints fail it `Pruned`, so a `block` older than their retention no longer fails. With no endpoint flagged `archive`, the `Pruned` error stands.
