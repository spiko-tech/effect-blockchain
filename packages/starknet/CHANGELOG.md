# @effect-blockchain/starknet

## 0.7.0

### Minor Changes

- [#123](https://github.com/spiko-tech/effect-blockchain/pull/123) [`952b383`](https://github.com/spiko-tech/effect-blockchain/commit/952b383d6eccdac1e24a2d500bac58c0557a9b75) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - Read native balances at many blocks in one call
  
  - `StarknetIndexer.fetchNativeBalances({ address, blocks, concurrency?, retry? })` returns the STRK balances in the order of `blocks`, with one `balanceOf` call per distinct block and none for an empty `blocks`. `concurrency` is 1 by default.
  - `StarknetIndexer.fetchNativeBalance` reads through `fetchNativeBalances` with one block.

## 0.6.0

### Minor Changes

- [#116](https://github.com/spiko-tech/effect-blockchain/pull/116) [`82ac02a`](https://github.com/spiko-tech/effect-blockchain/commit/82ac02afa9cc363abf48a6cf530574e2d292c6b9) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - Retry transient failures in every `StarknetIndexer` fetch
  
  - `StarknetIndexer.fetchEvents` takes an optional second argument `{ retry }`, and `StarknetIndexer.fetchNativeBalance` takes `retry` in its options. `retry` retries each `starknet_getEvents` page or `starknet_call` failing with a transient reason (`JsonRpc.isTransient`), so a retry keeps the pages already read. A cursor page still failing after its retries restarts its range once, as before. It is off by default.
  - The JSDoc of both methods states their request cost.

### Patch Changes

- Updated dependencies [[`95dbf54`](https://github.com/spiko-tech/effect-blockchain/commit/95dbf54e9731e86edb85a675429c586320b8a747)]:
  - @effect-blockchain/core@0.3.0

## 0.5.0

### Minor Changes

- [#110](https://github.com/spiko-tech/effect-blockchain/pull/110) [`cb36590`](https://github.com/spiko-tech/effect-blockchain/commit/cb36590e773853038d7a8b42f648e640a89daa10) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - Estimate fees and read class hashes
  
  - `StarknetRpc.getClassHashAt` reads `starknet_getClassHashAt` at a block tag. An address without a contract is `Rejected` with the code 20 (`CONTRACT_NOT_FOUND`), as in `getNonce`.
  - `StarknetRelayer.estimateFees` returns the `StarknetFees` that `sign` would use for the same calls, from a `signer` or an `address`, with the node's `overallFee`.
  - `StarknetRelayer.estimateDeployAccountFees` does the same for the deployment `signDeployAccount` would sign. Both share the estimate of `sign`, so the layer's `fees` strategy and `feeMultiplier` apply.

## 0.4.0

### Minor Changes

- [#100](https://github.com/spiko-tech/effect-blockchain/pull/100) [`89b39fd`](https://github.com/spiko-tech/effect-blockchain/commit/89b39fd1ef9c5e9cd87dad38cdd42f6d806bb465) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - Require starknet.js 10
  
  - Breaking: users of `StarknetRelayer` and `StarknetSigner` must upgrade the optional `starknet` peer dependency from `^8.9.2` to `^10.0.0`.
  - Bump the `starknet` dev dependency from 8.9.2 to 10.8.0.

## 0.3.0

### Minor Changes

- [#87](https://github.com/spiko-tech/effect-blockchain/pull/87) [`e80c678`](https://github.com/spiko-tech/effect-blockchain/commit/e80c678461917654ffef322ae54eaeeebc77275f) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - `StarknetRelayer` follows the shape of the other chains' relayers, and recovers better after an endpoint fallback.
  
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

- [#85](https://github.com/spiko-tech/effect-blockchain/pull/85) [`5d75cb8`](https://github.com/spiko-tech/effect-blockchain/commit/5d75cb8761d7ed6b8443e74434ee4f9e123a0633) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - `StarknetRelayer.awaitConfirmation` no longer ends on a transient RPC error.
  
  - A status read failing with a transient reason (`JsonRpc.isTransient`: `Unavailable`, `InvalidResponse`, `Lagging`) is read again on `poll`. It used to fail the wait, leaving the caller unable to tell whether the transaction landed. Any other error still fails the wait, and a `poll` that ends first returns the last read.
  - `StarknetRelayer.DEFAULT_POLL_INTERVAL` is exported, the same value as `StarknetIndexer.DEFAULT_POLL_INTERVAL`.

### Patch Changes

- [#91](https://github.com/spiko-tech/effect-blockchain/pull/91) [`90ca1fa`](https://github.com/spiko-tech/effect-blockchain/commit/90ca1fa28406bffe7b4d2abc921608f44de8f897) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - Shorten the module docs and document the shared semantics once
  
  - Module headers are 1 to 3 sentences with one `@example`, and link to `docs/concepts.md` for the rules shared by the chains: endpoint fallback, error reasons, stream options, the stateless relayer, transaction statuses, confirmations and signers.
  - `StarknetRpcError` and the Indexer stream options link to the shared description instead of repeating it.
  - The README has an Rpc and Indexer example and a Relayer example, both type-checked.
  - `StarknetRpcEndpoint` documents that a `getEvents` cursor goes to the first endpoint with the name of the one that issued it.

- [#83](https://github.com/spiko-tech/effect-blockchain/pull/83) [`be71305`](https://github.com/spiko-tech/effect-blockchain/commit/be71305609118c749c0e38b46d60bcb4c45520eb) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - Pin `@effect-blockchain/core` to the exact version released with this package (`workspace:*`)
  
  - The chain packages use core APIs marked `@internal`, so each release now depends on one exact core version instead of a caret range.
  - The `starknet` peer dependency is now optional: only `StarknetRelayer` and `StarknetSigner` import it. Import `StarknetRpc` and `StarknetIndexer` by subpath when it is not installed.
- Updated dependencies [[`5d75cb8`](https://github.com/spiko-tech/effect-blockchain/commit/5d75cb8761d7ed6b8443e74434ee4f9e123a0633), [`2c0d672`](https://github.com/spiko-tech/effect-blockchain/commit/2c0d672c3288722af9019ec503bf9519b1df51cd), [`90ca1fa`](https://github.com/spiko-tech/effect-blockchain/commit/90ca1fa28406bffe7b4d2abc921608f44de8f897)]:
  - @effect-blockchain/core@0.2.0

## 0.2.0

### Minor Changes

- [#66](https://github.com/spiko-tech/effect-blockchain/pull/66) [`d02c4bf`](https://github.com/spiko-tech/effect-blockchain/commit/d02c4bfa8f5a8b10836008817db0603821a76796) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - Read the STRK balance of an address, in fri, at a block or sampled every `step` blocks.
  
  - `StarknetRpc.call`: `starknet_call` at a block number, returning the raw felts, behind the head guard.
  - `StarknetNetwork.STRK_TOKEN_ADDRESS`: the STRK token contract, the same on mainnet and Sepolia.
  - `StarknetIndexer.fetchNativeBalance` and `StarknetIndexer.streamNativeBalance`, with the `StarknetNativeBalance` and `StarknetIndexerNativeBalanceOptions` types.
  - The `StarknetRpc` and `StarknetIndexer` services gain these members, so a hand-written implementation of either (a test fake) needs them too.

- [#79](https://github.com/spiko-tech/effect-blockchain/pull/79) [`f36d150`](https://github.com/spiko-tech/effect-blockchain/commit/f36d1509feb52bb06aa3b4931bca22e56bf510f1) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - Sign and broadcast Starknet transactions, and deploy an account.
  
  - `StarknetRelayer.sign({ signer, calls, nonce?, resourceBounds?, tip? })` signs an `INVOKE` V3 running `calls` (`{ contractAddress, entrypoint, calldata }`) through the `__execute__` entrypoint of a Cairo 1 account, and returns `{ hash, signed, nonce }` before anything is sent. A missing nonce is the account's nonce at the pre-confirmed block, missing resource bounds come from the fee strategy over `starknet_estimateFee`, a missing tip is 0.
  - `StarknetRelayer.signDeployAccount({ signer, classHash, salt, constructorCalldata, resourceBounds?, tip? })` signs the `DEPLOY_ACCOUNT` V3 of the signer's own account. The address these deploy to is computed and must be `signer.address`.
  - `StarknetRelayer.broadcast({ signed })` sends either transaction and returns its hash. A node that already has the transaction (`DUPLICATE_TX`, or an invalid nonce while it knows the hash) is a success. `INVALID_TRANSACTION_NONCE`, `INSUFFICIENT_ACCOUNT_BALANCE`, `INSUFFICIENT_RESOURCES_FOR_VALIDATE`, `FEE_BELOW_MINIMUM`, `VALIDATION_FAILURE` and `REPLACEMENT_TRANSACTION_UNDERPRICED` fail with a `StarknetBroadcastError` whose `reason` is `InvalidNonce`, `InsufficientBalance`, `InsufficientResources`, `ValidationFailure` or `ReplacementUnderpriced`.
  - `StarknetRelayer.layer` takes `fees`, a strategy from a `StarknetFeeEstimate` to `StarknetResourceBounds`. `StarknetRelayer.defaultFees` is the default: 1.5 times each estimated amount at 1.5 times its estimated price, after 300,000 L2 gas for the account's validation, which the unsigned estimate leaves out.
  - `StarknetRpc.estimateFee` takes and returns non-empty arrays: a reply without an estimate is an `InvalidResponse`.
  - `StarknetRpc.getTransactionStatus` accepts the `"failure_reason": null` that starknet-devnet answers.
  
  The `StarknetRelayer` service gains `sign`, `signDeployAccount` and `broadcast`, so a hand-written fake (`StarknetRelayer.of(...)`) needs the three new entries.

- [#73](https://github.com/spiko-tech/effect-blockchain/pull/73) [`b7f659d`](https://github.com/spiko-tech/effect-blockchain/commit/b7f659d2eb523eb660773785ff033f8eb03f4e2f) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - Follow a Starknet transaction until it is final.
  
  - `StarknetRelayer.fetchTransactionStatus({ hash })` returns `Pending`, `Included { block }`, `Confirmed { block }`, `Failed { block, reason }` or `NotFound`. A received, candidate or pre-confirmed transaction is `Pending`. `Confirmed` and `Failed` are only reported at or below the last confirmed block, with the same `confirmations` rule as `StarknetIndexer`, and `reason` is the node's revert message.
  - `StarknetRelayer.awaitConfirmation({ hash, poll? })` polls it until `Confirmed` or `Failed`.
  - `StarknetRpc.getTransactionStatus({ transactionHash })` over `starknet_getTransactionStatus` (JSON-RPC spec v0.9), with the `StarknetTransactionStatusResult` model. It returns `null` when the last endpoint tried answers `TXN_HASH_NOT_FOUND`.
  
  The `StarknetRpc` service gains a member, so a hand-written fake (`StarknetRpc.of(...)`) needs a `getTransactionStatus` entry.

- [#78](https://github.com/spiko-tech/effect-blockchain/pull/78) [`fb43cf7`](https://github.com/spiko-tech/effect-blockchain/commit/fb43cf7464a2204f805708e816579f30269445e7) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - Sign Starknet transactions, and the RPC methods sending them needs.
  
  - `StarknetSigner`: a signer value for V3 `INVOKE` and `DEPLOY_ACCOUNT` transactions, built with `fromPrivateKey({ address, key })` (a local Stark curve key) or `fromHashSigner({ address, signHash })` (a custody API that signs a hash). It returns the signature felts of the account contract, `[r, s]` for OpenZeppelin and Argent accounts. Failures are a `StarknetSignerError`.
  - `StarknetTransaction`: the `StarknetInvokeTransaction`, `StarknetDeployAccountTransaction` and `StarknetResourceBounds` models.
  - `StarknetRpc` gains `getNonce`, `estimateFee` (with `skipValidate` for unsigned transactions), `addInvokeTransaction` and `addDeployAccountTransaction`, with the `StarknetBlockTag` and `StarknetFeeEstimate` models.
  
  The `StarknetRpc` service gains members, so a hand-written fake (`StarknetRpc.of(...)`) needs the four new entries.

### Patch Changes

- [#70](https://github.com/spiko-tech/effect-blockchain/pull/70) [`9614244`](https://github.com/spiko-tech/effect-blockchain/commit/961424422c9873a1c55e2c227947d5f3668a38d3) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - Keep `StarknetRpc` to standard JSON-RPC methods.
  
  - Remove `StarknetRpc.getBalance`: `StarknetIndexer.fetchNativeBalance` and `streamNativeBalance` read STRK `balanceOf` over `StarknetRpc.call` and decode the u256 themselves.
  - A `balanceOf` reply that is not two felts fails with a `StarknetRpcError` (`InvalidResponse`, endpoint `StarknetIndexer`) and is not retried on the next endpoint.

## 0.1.0

### Minor Changes

- [#58](https://github.com/spiko-tech/effect-blockchain/pull/58) [`b21f4e0`](https://github.com/spiko-tech/effect-blockchain/commit/b21f4e0c73c66efdcd796b98f21dd378357665b0) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - Initial release.
  
  - `StarknetRpc`: typed, read-only Starknet JSON-RPC methods over an ordered list of endpoints with fallback.
  - `StarknetIndexer`: the last confirmed block, the events of a contract over a block range, and a stream of them following the confirmed head.
  - `StarknetNetwork`: named Starknet networks and their chain IDs.
  - Schemas for `StarknetAddress`, `StarknetBlock`, `StarknetEvent` and `StarknetTransactionHash`, built on starknet.js.

### Patch Changes

- Updated dependencies [[`b21f4e0`](https://github.com/spiko-tech/effect-blockchain/commit/b21f4e0c73c66efdcd796b98f21dd378357665b0)]:
  - @effect-blockchain/core@0.1.0
