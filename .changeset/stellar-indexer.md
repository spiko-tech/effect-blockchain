---
"@effect-blockchain/stellar": patch
---

Adds a raw Soroban contract event indexer over `StellarRpc`.

- Adds `StellarIndexer`: `lastConfirmedBlock` (latest ledger minus the confirmations) and `fetchEvents` (a `getEvents` filter without `limit` and `cursor`, over any ledger range, in chain order). The range is fetched in chunks of `maxBlockRange` ledgers (default `DEFAULT_MAX_BLOCK_RANGE`, 10000, the RPC's scan window), `contractIds` in groups of 5 (the RPC limit), each chunk paged with the cursor. A failed cursor page restarts its chunk once from the first page. Events of failed contract calls are dropped.
- Adds `StellarNetwork.defaultConfirmations`: `0` for `Stellar` and `StellarTestnet`, a closed ledger is final.
