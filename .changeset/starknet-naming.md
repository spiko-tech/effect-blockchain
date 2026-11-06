---
"@effect-blockchain/starknet": patch
---

Naming polish before the first release.

- **Breaking:** `NullStarknetAddress` is renamed `NULL_ADDRESS`.
- New `StarknetIndexerStreamOptions` type (the `streamEvents` options).
- Schema titles are human-readable: "Starknet address", "Starknet network", "Starknet transaction hash".
- `defaultConfirmations` is documented under `getters`; `StarknetRpc` method parameters are named `options`.
- Docs call a `maxBlockRange` slice a range, never a chunk (`chunkSize` is the page size).
- Docgen source links now point to `packages/starknet/src/`.
