---
"@effect-blockchain/stellar": patch
---

Read the account entry at the highest requested block in `StellarIndexer.fetchNativeBalances`

- The `getLedgerEntries` call sends `minLedger` at the highest of `blocks` instead of the lowest, so an endpoint that has not reached the highest block no longer answers, and the balances at the higher blocks include every change up to them.
