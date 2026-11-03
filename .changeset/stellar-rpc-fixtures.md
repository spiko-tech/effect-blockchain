---
"@effect-blockchain/stellar": patch
---

`StellarRpc` tests now replay real Stellar pubnet replies recorded from Quasar. No API change.

- Adds `scripts/record-fixtures.ts` (`pnpm record-fixtures [startLedger]`), which records pinned requests into `test/fixtures/<provider>/<case>.json` and fails if a key or keyed URL reaches a fixture.
- Adds `test/StellarRpc.fixtures.test.ts`: `getNetwork`, EUTBL and USTBL `getEvents` with cursor paging, `Pruned`, `Lagging`, invalid params (`Rejected` -32602), an invalid key (`Unavailable` 401) and a fallback from it.
- `getLatestLedger` is not recorded: its reply carries `headerXdr` and `metadataXdr` (about 3.3 MB on protocol 29).
