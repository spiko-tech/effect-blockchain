---
"@effect-blockchain/evm": minor
---

Align `EvmRelayer` and `EvmSigner` with the other chains.

- `EvmRelayer.sign` fails with the new `EvmSimulationError` (`reason: SimulationFailed`, holding the node's message) when the node refuses `eth_estimateGas`, as for a call that reverts.
- `EvmRelayer.layerConfig` builds the Relayer from `Config` (`confirmations`, `gasMultiplier`).
- `EvmRelayer.EvmTransactionStatusOptions` is exported: the input of `fetchTransactionStatus` and `awaitConfirmation`.
- Breaking: `EvmSigner.fromPrivateKey(key)` is now `EvmSigner.fromPrivateKey({ key })`.
- Breaking: the `EvmBroadcastError` reason `NonceTooLow` is renamed `InvalidNonce`.
- Breaking: a refused gas estimate in `EvmRelayer.sign` is no longer an `EvmRpcError` with reason `Rejected`: catch `EvmSimulationError`. Transport and node failures stay `EvmRpcError`.
- Breaking: `reason` of the `Failed` status is typed `undefined` (was `EvmHexData | undefined`, and never set): a receipt does not carry the revert data.
