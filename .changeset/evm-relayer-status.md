---
"@effect-blockchain/evm": minor
---

Follow a transaction until it is final, and sign EVM transactions.

- `EvmRelayer.fetchTransactionStatus({ hash })` returns `Pending`, `Included { block }`, `Confirmed { block }`, `Failed { block, reason }` or `NotFound`. `Confirmed` and `Failed` are only reported at or below the last confirmed block, with the same `confirmations` rule as `EvmIndexer`.
- `EvmRelayer.awaitConfirmation({ hash, poll? })` polls it until `Confirmed` or `Failed`.
- `EvmSigner`: a signer value for EIP-1559 transactions, built with `fromPrivateKey` (a local key) or `fromHashSigner` (a custody API that signs a hash). Failures are an `EvmSignerError`.
- `EvmRpc` gains `getTransactionByHash`, `getTransactionReceipt`, `sendRawTransaction`, `getTransactionCount`, `estimateGas` and `feeHistory`, with the `EvmTransaction`, `EvmTransactionReceipt`, `EvmFeeHistory` and `EvmBlockTag` models.

The `EvmRpc` service gains members, so a hand-written fake (`EvmRpc.of(...)`) needs the six new entries.
