---
"@effect-blockchain/starknet": minor
---

Estimate fees and read class hashes

- `StarknetRpc.getClassHashAt` reads `starknet_getClassHashAt` at a block tag. An address without a contract is `Rejected` with the code 20 (`CONTRACT_NOT_FOUND`), as in `getNonce`.
- `StarknetRelayer.estimateFees` returns the `StarknetFees` that `sign` would use for the same calls, from a `signer` or an `address`, with the node's `overallFee`.
- `StarknetRelayer.estimateDeployAccountFees` does the same for the deployment `signDeployAccount` would sign. Both share the estimate of `sign`, so the layer's `fees` strategy and `feeMultiplier` apply.
