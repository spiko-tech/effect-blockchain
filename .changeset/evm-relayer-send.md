---
"@effect-blockchain/evm": minor
---

Sign and broadcast EVM transactions.

- `EvmRelayer.sign({ signer, to, data?, value?, nonce?, gas?, fees? })` signs an EIP-1559 transaction and returns `{ hash, signed, nonce }` before anything is sent. A missing nonce is the sender's pending transaction count, a missing gas limit is `eth_estimateGas` times `gasMultiplier` (1.2 by default), missing fees come from the fee strategy.
- `EvmRelayer.broadcast({ signed })` sends it and returns its hash. A node that already has the transaction is a success. `nonce too low`, `replacement transaction underpriced`, `insufficient funds` and a fee below the node's minimum fail with an `EvmBroadcastError` whose `reason` is `NonceTooLow`, `ReplacementUnderpriced`, `InsufficientFunds` or `FeeTooLow`.
- `EvmRelayer.layer` takes `fees`, a strategy from an `EvmFeeEstimate` (the next base fee and the recent reward percentiles of `eth_feeHistory`) to `EvmFees`, and `gasMultiplier`. `EvmRelayer.defaultFees` is the default: the median 50th percentile reward, at least 0.001 gwei, and twice the next base fee plus that priority fee.
- `EvmFeeHistory.baseFeePerGas` is a non-empty array: a reply without a base fee is an `InvalidResponse`.

The `EvmRelayer` service gains `sign` and `broadcast`, so a hand-written fake (`EvmRelayer.of(...)`) needs the two new entries.
