---
"@effect-blockchain/solana": minor
---

Align `SolanaRelayer` and `SolanaSigner` with the other chains, and fix two status bugs.

- Breaking: `SolanaRelayer.sign` takes `signer` and `cosigners` in place of `feePayer` and `signers`. `signer` pays the fee and signs first.
- Breaking: `sign` takes `fees: { computeUnitPrice }` (the new `SolanaFees`) in place of `computeUnitPrice`. `computeUnitLimit` stays an option of `sign`.
- Breaking: `defaultFees` and the layer's `fees` strategy have the signature `(estimate: SolanaFeeEstimate) => SolanaFees`, where `SolanaFeeEstimate` is `{ prioritizationFees }`. They took the prioritization fees and returned a `bigint`.
- Breaking: `sign` fails with `SolanaSimulationError`, whose `reason` is `SimulationFailed`, in place of the bare `SimulationFailed`. A failed broadcast preflight stays a `SimulationFailed` reason of `SolanaBroadcastError`.
- Breaking: the `InsufficientFundsForFee` reason of `SolanaBroadcastError` is renamed `InsufficientFunds`.
- Breaking: `instructions` is an `Arr.NonEmptyReadonlyArray`.
- Breaking: `SolanaSigner.fromPrivateKey` takes `{ key }` in place of a bare `Redacted`.
- `sign` fails with a `SolanaSignerError` for a `computeUnitLimit` that is not an integer from 0 to 1,400,000 or a compute unit price that is not a u64. It used to wrap the limit silently and die with a `RangeError` on the price.
- Fix: `SolanaRpc.getSignatureStatuses` called without `searchTransactionHistory` sent an empty config, which Agave 3.1 refuses. It now sends `searchTransactionHistory: false`.
- Fix: `fetchTransactionStatus` no longer reports `Expired` when the endpoint that does not know the transaction is behind the finalized block above `lastValidBlockHeight`. It reads that block's slot with `getEpochInfo` and requires the status to be answered at that slot or later, and answers `NotFound` otherwise.
- New `SolanaRpc.getEpochInfo` and `SolanaEpochInfo`.
- New `SolanaRelayer.layerConfig`, reading `confirmations` and `computeUnitMultiplier` from `Config`.
