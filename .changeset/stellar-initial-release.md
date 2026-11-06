---
"@effect-blockchain/stellar": minor
---

Initial release.

- `StellarRpc`: typed, read-only Stellar RPC methods over an ordered list of endpoints with fallback.
- `StellarIndexer`: the last confirmed ledger, the Soroban contract events of a set of contracts over a ledger range, and a stream of them following the confirmed head.
- `StellarNetwork`: named Stellar networks and their passphrases.
- Schemas for `StellarAddress` (account and contract strkeys), `StellarContractEvent` and `StellarTransactionHash`, built on `@stellar/stellar-sdk`.
