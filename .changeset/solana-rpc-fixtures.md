---
"@effect-blockchain/solana": patch
---

`SolanaRpc` tests now replay real Alchemy mainnet replies through the real layer. The API is unchanged.

- Adds `scripts/record-fixtures.ts` (`pnpm record-fixtures`), which records pinned requests on the EUTBL mint into `test/fixtures/alchemy/*.json` and fails if a key or provider URL ends up in a fixture.
- Adds `test/SolanaRpc.fixtures.test.ts`, covering `getGenesisHash`, `getSlot`, two `getSignaturesForAddress` pages, two `getTransaction` replies with exact u64 values, an unknown signature (`Pruned`), `minContextSlot` above the head, invalid params (`Rejected` -32602), an invalid key (`Unavailable` 401) and the fallback from that invalid key.
- Type-checks `packages/*/scripts` with `tsconfig.tests.json`.
