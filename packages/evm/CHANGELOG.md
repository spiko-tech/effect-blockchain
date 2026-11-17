# @effect-blockchain/evm

## 0.3.0

### Minor Changes

- [#65](https://github.com/spiko-tech/effect-blockchain/pull/65) [`0b69ff2`](https://github.com/spiko-tech/effect-blockchain/commit/0b69ff24148e98bc31d5ac82fe2b078e75d15e76) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - Read the native balance (wei) of an address at a block.
  
  - `EvmRpc.getBalance({ address, blockNumber })` over `eth_getBalance`, only answered by an endpoint whose head has reached the block. Past blocks need archive endpoints.
  - `EvmIndexer.fetchNativeBalance({ address, block })` and `EvmIndexer.streamNativeBalance({ address, fromBlock, toBlock?, step, poll?, retry? })`, a sample every `step` blocks following the confirmed head.
  - New `EvmNativeBalance` and `EvmIndexerNativeBalanceOptions` types.
  
  The `EvmRpc` and `EvmIndexer` services gain members, so a hand-written fake of either service (`EvmRpc.of(...)`, `EvmIndexer.of(...)`) needs `getBalance`, `fetchNativeBalance` and `streamNativeBalance` entries.

- [#72](https://github.com/spiko-tech/effect-blockchain/pull/72) [`22083db`](https://github.com/spiko-tech/effect-blockchain/commit/22083db82609614738a1739e78d69d6c37ae99b3) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - Sign and broadcast EVM transactions.
  
  - `EvmRelayer.sign({ signer, to, data?, value?, nonce?, gas?, fees? })` signs an EIP-1559 transaction and returns `{ hash, signed, nonce }` before anything is sent. A missing nonce is the sender's pending transaction count, a missing gas limit is `eth_estimateGas` times `gasMultiplier` (1.2 by default), missing fees come from the fee strategy.
  - `EvmRelayer.broadcast({ signed })` sends it and returns its hash. A node that already has the transaction is a success. `nonce too low`, `replacement transaction underpriced`, `insufficient funds` and a fee below the node's minimum fail with an `EvmBroadcastError` whose `reason` is `NonceTooLow`, `ReplacementUnderpriced`, `InsufficientFunds` or `FeeTooLow`.
  - `EvmRelayer.layer` takes `fees`, a strategy from an `EvmFeeEstimate` (the next base fee and the recent reward percentiles of `eth_feeHistory`) to `EvmFees`, and `gasMultiplier`. `EvmRelayer.defaultFees` is the default: the median 50th percentile reward, at least 0.001 gwei, and twice the next base fee plus that priority fee.
  - `EvmFeeHistory.baseFeePerGas` is a non-empty array: a reply without a base fee is an `InvalidResponse`.
  
  The `EvmRelayer` service gains `sign` and `broadcast`, so a hand-written fake (`EvmRelayer.of(...)`) needs the two new entries.

- [#71](https://github.com/spiko-tech/effect-blockchain/pull/71) [`dd7b859`](https://github.com/spiko-tech/effect-blockchain/commit/dd7b85967e226b9da19b6abf8ff8b8846a9a227d) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - Follow a transaction until it is final, and sign EVM transactions.
  
  - `EvmRelayer.fetchTransactionStatus({ hash })` returns `Pending`, `Included { block }`, `Confirmed { block }`, `Failed { block, reason }` or `NotFound`. `Confirmed` and `Failed` are only reported at or below the last confirmed block, with the same `confirmations` rule as `EvmIndexer`.
  - `EvmRelayer.awaitConfirmation({ hash, poll? })` polls it until `Confirmed` or `Failed`.
  - `EvmSigner`: a signer value for EIP-1559 transactions, built with `fromPrivateKey` (a local key) or `fromHashSigner` (a custody API that signs a hash). Failures are an `EvmSignerError`.
  - `EvmRpc` gains `getTransactionByHash`, `getTransactionReceipt`, `sendRawTransaction`, `getTransactionCount`, `estimateGas` and `feeHistory`, with the `EvmTransaction`, `EvmTransactionReceipt`, `EvmFeeHistory` and `EvmBlockTag` models.
  
  The `EvmRpc` service gains members, so a hand-written fake (`EvmRpc.of(...)`) needs the six new entries.

## 0.2.0

### Minor Changes

- [#63](https://github.com/spiko-tech/effect-blockchain/pull/63) [`200541c`](https://github.com/spiko-tech/effect-blockchain/commit/200541cc2260b87c4d725a73c2a5cdd4b2393f09) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - Add the Anvil local network (chain ID 31337).
  
  `EvmNetwork` gains the `"Anvil"` literal, so an exhaustive `Record<EvmNetwork, ...>` in caller code needs an `Anvil` entry.

## 0.1.0

### Minor Changes

- [#58](https://github.com/spiko-tech/effect-blockchain/pull/58) [`b21f4e0`](https://github.com/spiko-tech/effect-blockchain/commit/b21f4e0c73c66efdcd796b98f21dd378357665b0) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - Initial release.
  
  - `EvmRpc`: typed, read-only EVM JSON-RPC methods (`eth_chainId`, `eth_blockNumber`, `eth_getBlockByNumber`, `eth_getLogs`) over an ordered list of endpoints with fallback.
  - `EvmIndexer`: the last confirmed block, the logs of a set of contracts over a block range, and a stream of them following the confirmed head.
  - `EvmNetwork`: named EVM networks and their chain IDs.
  - Schemas for `EvmAddress`, `EvmBlock`, `EvmLog`, `EvmHexData` and `EvmTransactionHash`, built on viem.

### Patch Changes

- Updated dependencies [[`b21f4e0`](https://github.com/spiko-tech/effect-blockchain/commit/b21f4e0c73c66efdcd796b98f21dd378357665b0)]:
  - @effect-blockchain/core@0.1.0
