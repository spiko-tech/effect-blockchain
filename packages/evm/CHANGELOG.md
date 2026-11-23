# @effect-blockchain/evm

## 0.7.0

### Minor Changes

- [#123](https://github.com/spiko-tech/effect-blockchain/pull/123) [`952b383`](https://github.com/spiko-tech/effect-blockchain/commit/952b383d6eccdac1e24a2d500bac58c0557a9b75) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - Read native balances at many blocks in one call
  
  - `EvmIndexer.fetchNativeBalances({ address, blocks, concurrency?, retry? })` returns the balances in the order of `blocks`, with one `eth_getBalance` per distinct block and none for an empty `blocks`. `concurrency` is 1 by default.
  - `EvmIndexer.fetchNativeBalance` reads through `fetchNativeBalances` with one block.

## 0.6.0

### Minor Changes

- [#116](https://github.com/spiko-tech/effect-blockchain/pull/116) [`82ac02a`](https://github.com/spiko-tech/effect-blockchain/commit/82ac02afa9cc363abf48a6cf530574e2d292c6b9) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - Retry transient failures in every `EvmIndexer` fetch
  
  - `EvmIndexer.fetchLogs` takes an optional second argument `{ retry }`, and `EvmIndexer.fetchNativeBalance` takes `retry` in its options. `retry` retries each `eth_getLogs` or `eth_getBalance` failing with a transient reason (`JsonRpc.isTransient`), so a retry keeps the ranges already read. It is off by default.
  - The JSDoc of both methods states their request cost.

### Patch Changes

- Updated dependencies [[`95dbf54`](https://github.com/spiko-tech/effect-blockchain/commit/95dbf54e9731e86edb85a675429c586320b8a747)]:
  - @effect-blockchain/core@0.3.0

## 0.5.0

### Minor Changes

- [#112](https://github.com/spiko-tech/effect-blockchain/pull/112) [`4450fe8`](https://github.com/spiko-tech/effect-blockchain/commit/4450fe8f88f605c5db7563caad4dfa04a227a463) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - Add `EvmRpc.call` in `@effect-blockchain/evm` 0.5.0
  
  - `EvmRpc.call({ to, data, from, blockTag })` sends `eth_call` and returns the call's return data as `EvmHexData`, with the same endpoint fallback, retries and error reasons as the other methods.
  - A call that reverts fails with `Rejected` and the node's code (3 on geth and its forks) and message.

## 0.4.0

### Minor Changes

- [#86](https://github.com/spiko-tech/effect-blockchain/pull/86) [`a878c81`](https://github.com/spiko-tech/effect-blockchain/commit/a878c81adfcc2ee8627be0e5c30cd7418fbbfb6a) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - Align `EvmRelayer` and `EvmSigner` with the other chains.
  
  - `EvmRelayer.sign` fails with the new `EvmSimulationError` (`reason: SimulationFailed`, holding the node's message) when the node refuses `eth_estimateGas`, as for a call that reverts.
  - `EvmRelayer.layerConfig` builds the Relayer from `Config` (`confirmations`, `gasMultiplier`).
  - `EvmRelayer.EvmTransactionStatusOptions` is exported: the input of `fetchTransactionStatus` and `awaitConfirmation`.
  - Breaking: `EvmSigner.fromPrivateKey(key)` is now `EvmSigner.fromPrivateKey({ key })`.
  - Breaking: the `EvmBroadcastError` reason `NonceTooLow` is renamed `InvalidNonce`.
  - Breaking: a refused gas estimate in `EvmRelayer.sign` is no longer an `EvmRpcError` with reason `Rejected`: catch `EvmSimulationError`. Transport and node failures stay `EvmRpcError`.
  - Breaking: `reason` of the `Failed` status is typed `undefined` (was `EvmHexData | undefined`, and never set): a receipt does not carry the revert data.

- [#85](https://github.com/spiko-tech/effect-blockchain/pull/85) [`5d75cb8`](https://github.com/spiko-tech/effect-blockchain/commit/5d75cb8761d7ed6b8443e74434ee4f9e123a0633) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - `EvmRelayer.awaitConfirmation` no longer ends on a transient RPC error.
  
  - A status read failing with a transient reason (`JsonRpc.isTransient`: `Unavailable`, `InvalidResponse`, `Lagging`) is read again on `poll`. It used to fail the wait, leaving the caller unable to tell whether the transaction landed. Any other error still fails the wait, and a `poll` that ends first returns the last read.
  - `EvmRelayer.DEFAULT_POLL_INTERVAL` is exported, the same value as `EvmIndexer.DEFAULT_POLL_INTERVAL`.

### Patch Changes

- [#91](https://github.com/spiko-tech/effect-blockchain/pull/91) [`90ca1fa`](https://github.com/spiko-tech/effect-blockchain/commit/90ca1fa28406bffe7b4d2abc921608f44de8f897) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - Shorten the module docs and document the shared semantics once
  
  - Module headers are 1 to 3 sentences with one `@example`, and link to `docs/concepts.md` for the rules shared by the chains: endpoint fallback, error reasons, stream options, the stateless relayer, transaction statuses, confirmations and signers.
  - `EvmRpcError` and the Indexer stream options link to the shared description instead of repeating it.
  - The README has an Rpc and Indexer example and a Relayer example, both type-checked.
  - The default confirmations of `EvmNetwork` cite protocol documentation, and the Polygon and BNB Smart Chain entries say why they keep a margin.

- [#83](https://github.com/spiko-tech/effect-blockchain/pull/83) [`be71305`](https://github.com/spiko-tech/effect-blockchain/commit/be71305609118c749c0e38b46d60bcb4c45520eb) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - Pin `@effect-blockchain/core` to the exact version released with this package (`workspace:*`)
  
  - The chain packages use core APIs marked `@internal`, so each release now depends on one exact core version instead of a caret range.
- Updated dependencies [[`5d75cb8`](https://github.com/spiko-tech/effect-blockchain/commit/5d75cb8761d7ed6b8443e74434ee4f9e123a0633), [`2c0d672`](https://github.com/spiko-tech/effect-blockchain/commit/2c0d672c3288722af9019ec503bf9519b1df51cd), [`90ca1fa`](https://github.com/spiko-tech/effect-blockchain/commit/90ca1fa28406bffe7b4d2abc921608f44de8f897)]:
  - @effect-blockchain/core@0.2.0

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
