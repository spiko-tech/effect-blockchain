---
"@effect-blockchain/stellar": minor
---

Align `StellarRelayer` and `StellarSigner` with the other chains, and stop two ways a transaction could fail late.

- `sign` fails with a `StellarSimulationError` of reason `RestoreRequired` (`transactionData`, `minResourceFee`) when the simulation returns a `restorePreamble`. It used to sign the invocation, which then failed in a ledger and paid its fee. `StellarRpc.simulateTransaction` now returns `restorePreamble`.
- A result code this version does not list no longer throws inside `broadcast` and `fetchTransactionStatus`: it reads `undefined`.
- New `StellarRelayer.layerConfig` (`confirmations`, `validity`), `StellarFees`, `StellarFeeEstimate` and `StellarTransactionStatusOptions`.
- `StellarBroadcastError` has a `cause` holding the node's reply.
- Breaking: `feeBump` returns a full `StellarSignedTransaction` (`hash`, `signed`, `sequence`, `maxLedger` of the inner transaction) instead of `{ hash, signed }`, so `awaitConfirmation(bumped)` can end in `Expired`.
- Breaking: `sign({ fee })` and `feeBump({ fee })` are replaced by `fees: { fee }` (`StellarFees`, stroops per operation).
- Breaking: `defaultFees` and the `fees` option of `layer` are `(estimate: StellarFeeEstimate) => StellarFees` instead of `(inclusionFee: StellarFeeDistribution) => bigint`.
- Breaking: a `txBadSeq` refusal is the reason `InvalidNonce` and a `txInsufficientBalance` refusal is `InsufficientFunds`, instead of `Refused` with that `code`. `Refused` keeps the other codes.
- Breaking: `StellarTransactionFailure.code` and each entry of `operations` (also on `Refused`) can be `undefined`.
- Breaking: `StellarSigner.fromPrivateKey({ key })` replaces `fromPrivateKey(key)`.
