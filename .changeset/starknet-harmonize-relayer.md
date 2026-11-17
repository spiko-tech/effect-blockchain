---
"@effect-blockchain/starknet": minor
---

`StarknetRelayer` follows the shape of the other chains' relayers, and recovers better after an endpoint fallback.

- Breaking: `sign` and `signDeployAccount` take `fees?: StarknetFees` (`{ resourceBounds, tip }`) instead of `resourceBounds` and `tip`.
- Breaking: `defaultFees` and the layer's `fees` strategy return a `StarknetFees` instead of a `StarknetResourceBounds`.
- Breaking: the `InsufficientBalance` broadcast reason is renamed `InsufficientFunds`.
- Breaking: `sign` and `signDeployAccount` fail with the new `StarknetSimulationError` (reason `SimulationFailed`) when `starknet_estimateFee` answers `TRANSACTION_EXECUTION_ERROR`, instead of a `StarknetRpcError` with the reason `Rejected`. The `StarknetRpcError` is its `cause`.
- Breaking: the `calls` of `sign` are an `Arr.NonEmptyReadonlyArray`.
- `StarknetRelayer.layer` takes `feeMultiplier` (default 1.5), the margin of the default fee strategy over the estimate.
- `StarknetRelayer.layerConfig` reads `confirmations` and `feeMultiplier` from `Config`.
- `StarknetTransactionStatusOptions` is exported.
- `broadcast` fails with the node's `StarknetRpcError` instead of dying on a transaction whose hash cannot be computed.
- `broadcast` checks whether the node knows the transaction when any endpoint answers `INVALID_TRANSACTION_NONCE`, where it used to read only the first refusal of a fallback.
- `StarknetRpc.getTransactionStatus` returns `null` when at least one endpoint answers `TXN_HASH_NOT_FOUND` and every other one fails with a transient reason, where it used to read only the last endpoint's code. An endpoint refusing the request is now an error wherever it comes in the order.
