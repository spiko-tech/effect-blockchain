# @effect-blockchain/stellar

## 0.1.0

### Minor Changes

- [#58](https://github.com/spiko-tech/effect-blockchain/pull/58) [`b21f4e0`](https://github.com/spiko-tech/effect-blockchain/commit/b21f4e0c73c66efdcd796b98f21dd378357665b0) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - Initial release.
  
  - `StellarRpc`: typed, read-only Stellar RPC methods over an ordered list of endpoints with fallback.
  - `StellarIndexer`: the last confirmed ledger, the Soroban contract events of a set of contracts over a ledger range, and a stream of them following the confirmed head.
  - `StellarNetwork`: named Stellar networks and their passphrases.
  - Schemas for `StellarAddress` (account and contract strkeys), `StellarContractEvent` and `StellarTransactionHash`, built on `@stellar/stellar-sdk`.

### Patch Changes

- Updated dependencies [[`b21f4e0`](https://github.com/spiko-tech/effect-blockchain/commit/b21f4e0c73c66efdcd796b98f21dd378357665b0)]:
  - @effect-blockchain/core@0.1.0
