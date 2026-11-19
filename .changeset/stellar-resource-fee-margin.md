---
"@effect-blockchain/stellar": minor
---

Margin on the simulated resource fee

- `StellarRelayer.layer` and `StellarRelayer.layerConfig` take `resourceFeeMultiplier` (default 1, so nothing changes without it), and `StellarRelayer.sign` takes the same option per call, which wins over the layer's. The simulation's `minResourceFee` of a Soroban invocation is multiplied, to the hundredth and rounded up, in the transaction's `sorobanData.resourceFee` and in its total fee. The margin lands in the refundable part of the resource fee, which guards against `invokeHostFunctionInsufficientRefundableFee`, and the node refunds what the transaction does not use.
- A `resourceFeeMultiplier` below 1, or not finite, fails `sign` with a `StellarSignerError` before any request.
