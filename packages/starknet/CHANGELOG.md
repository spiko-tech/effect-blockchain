# @effect-blockchain/starknet

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
