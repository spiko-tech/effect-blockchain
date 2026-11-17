---
"@effect-blockchain/stellar": minor
---

`StellarRpc.getLedgers` returns one page with its cursor, and endpoints can be flagged `archive`.

- Breaking: `getLedgers` returns a `StellarLedgersPage` (`{ ledgers, cursor, latestLedger, oldestLedger }`) instead of `ReadonlyArray<StellarLedger>`. Read `page.ledgers` where the array was used.
- `getLedgers` takes `{ startLedger, limit? }` or `{ cursor, limit? }` (`StellarLedgersOptions`). A `StellarLedgersCursor` is only sent to the endpoint that issued it, with no fallback, like a `getEvents` cursor.
- A page that does not start at the requested ledger or that skips a ledger fails `InvalidResponse`. A cursor the endpoint no longer retains fails `Pruned`.
- `StellarRpcEndpoint` gains `archive?: boolean`, also read by `layerConfig`. `getLedgers({ startLedger, archive: true })` only asks the endpoints flagged `archive`, in their configured order, and fails `Rejected` without a request when none is flagged. Every other call still goes through all the endpoints.
