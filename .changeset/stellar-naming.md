---
"@effect-blockchain/stellar": patch
---

Naming polish before the first release.

- **Breaking:** `NULL_STELLAR_ADDRESS` is renamed `NULL_ADDRESS`.
- New `StellarIndexerStreamOptions` type (the `streamEvents` options).
- Schema titles are human-readable: "Stellar account address", "Stellar contract address", "Stellar network", "Stellar transaction hash".
- `defaultConfirmations` is documented under `getters`.
- Docgen source links now point to `packages/stellar/src/`.
