---
"@effect-blockchain/stellar": minor
---

`StellarIndexer.fetchArchivedEvents` reads contract events older than a regular endpoint's retention from the archive endpoints.

- `fetchArchivedEvents({ filter, fromBlock, toBlock, concurrency?, retry? })` returns a `StellarIndexerBatch`. It pages `getLedgers` on the endpoints flagged `archive` and decodes each `LedgerCloseMeta` (`TransactionMeta` v3 and v4) into the contract events `getEvents` returns, ids included, with the same contract and topic filter. Events of failed transactions are left out.
- `LEDGERS_PAGE_SIZE` (10) is the `getLedgers` page size of the Indexer, and `StellarIndexerArchivedEventsOptions` the options type.
