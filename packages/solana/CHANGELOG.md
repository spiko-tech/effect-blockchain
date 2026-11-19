# @effect-blockchain/solana

## 0.3.2

### Patch Changes

- [#103](https://github.com/spiko-tech/effect-blockchain/pull/103) [`aed260d`](https://github.com/spiko-tech/effect-blockchain/commit/aed260d584db8819016876edb32a894a794cf458) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - Read version 1 transactions in `@effect-blockchain/solana` 0.3.2
  
  - `SolanaRpc.getTransaction` sends `maxSupportedTransactionVersion: 1` instead of 0, so the node returns legacy, version 0 and version 1 transactions instead of failing `-32015` (`Rejected`) on version 1, which stopped `SolanaIndexer.fetchTransactions` and `streamTransactions` on any range holding one.
  - The `json` message keeps every field it does not type as raw JSON, integers as decimal strings: `transactionConfig` on version 1.
  - `SolanaCompiledInstruction` is a type alias instead of an interface, with the same fields.

## 0.3.1

### Patch Changes

- [#95](https://github.com/spiko-tech/effect-blockchain/pull/95) [`ae478c2`](https://github.com/spiko-tech/effect-blockchain/commit/ae478c23a260893155d6fdac13d53febfc742fe4) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - `SolanaTransactionMeta` restores the status meta fields removed in 0.2.0: `getTransaction`, `fetchTransactions` and `streamTransactions` return every field the node sends again.
  
  - Every field the library does not type (`logMessages`, `computeUnitsConsumed`, `rewards`, `returnData`...) is kept as raw JSON, integers as decimal strings, as in 0.1.0. A field a node adds later is kept the same way.
  - New typed fields: `innerInstructions` (`SolanaInnerInstruction`, with `stackHeight`), `preTokenBalances` and `postTokenBalances` (`SolanaTokenBalance`, with `uiTokenAmount.amount` as an exact `bigint` and `decimals`). Each is absent or `null` when the node did not record it.
  - `SolanaRpcJson` is the type of the untyped fields: JSON in which an integer may be a `bigint`.

## 0.3.0

### Minor Changes

- [#89](https://github.com/spiko-tech/effect-blockchain/pull/89) [`c93f90e`](https://github.com/spiko-tech/effect-blockchain/commit/c93f90ef9fb26ccf5ecf53117f0bfba35eac28e8) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - Align `SolanaRelayer` and `SolanaSigner` with the other chains, and fix two status bugs.
  
  - Breaking: `SolanaRelayer.sign` takes `signer` and `cosigners` in place of `feePayer` and `signers`. `signer` pays the fee and signs first.
  - Breaking: `sign` takes `fees: { computeUnitPrice }` (the new `SolanaFees`) in place of `computeUnitPrice`. `computeUnitLimit` stays an option of `sign`.
  - Breaking: `defaultFees` and the layer's `fees` strategy have the signature `(estimate: SolanaFeeEstimate) => SolanaFees`, where `SolanaFeeEstimate` is `{ prioritizationFees }`. They took the prioritization fees and returned a `bigint`.
  - Breaking: `sign` fails with `SolanaSimulationError`, whose `reason` is `SimulationFailed`, in place of the bare `SimulationFailed`. A failed broadcast preflight stays a `SimulationFailed` reason of `SolanaBroadcastError`.
  - Breaking: the `InsufficientFundsForFee` reason of `SolanaBroadcastError` is renamed `InsufficientFunds`.
  - Breaking: `instructions` is an `Arr.NonEmptyReadonlyArray`.
  - Breaking: `SolanaSigner.fromPrivateKey` takes `{ key }` in place of a bare `Redacted`.
  - `sign` fails with a `SolanaSignerError` for a `computeUnitLimit` that is not an integer from 0 to 1,400,000 or a compute unit price that is not a u64. It used to wrap the limit silently and die with a `RangeError` on the price.
  - Fix: `SolanaRpc.getSignatureStatuses` called without `searchTransactionHistory` sent an empty config, which Agave 3.1 refuses. It now sends `searchTransactionHistory: false`.
  - Fix: `fetchTransactionStatus` no longer reports `Expired` when the endpoint that does not know the transaction is behind the finalized block above `lastValidBlockHeight`. It reads that block's slot with `getEpochInfo` and requires the status to be answered at that slot or later, and answers `NotFound` otherwise.
  - New `SolanaRpc.getEpochInfo` and `SolanaEpochInfo`.
  - New `SolanaRelayer.layerConfig`, reading `confirmations` and `computeUnitMultiplier` from `Config`.

- [#85](https://github.com/spiko-tech/effect-blockchain/pull/85) [`5d75cb8`](https://github.com/spiko-tech/effect-blockchain/commit/5d75cb8761d7ed6b8443e74434ee4f9e123a0633) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - `SolanaRelayer.awaitConfirmation` no longer ends on a transient RPC error.
  
  - A status read failing with a transient reason (`JsonRpc.isTransient`: `Unavailable`, `InvalidResponse`, `Lagging`) is read again on `poll`. It used to fail the wait, leaving the caller unable to tell whether the transaction landed. Any other error still fails the wait, and a `poll` that ends first returns the last read.
  - `SolanaRelayer.DEFAULT_POLL_INTERVAL` is exported, the same value as `SolanaIndexer.DEFAULT_POLL_INTERVAL`.

### Patch Changes

- [#91](https://github.com/spiko-tech/effect-blockchain/pull/91) [`90ca1fa`](https://github.com/spiko-tech/effect-blockchain/commit/90ca1fa28406bffe7b4d2abc921608f44de8f897) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - Shorten the module docs and document the shared semantics once
  
  - Module headers are 1 to 3 sentences with one `@example`, and link to `docs/concepts.md` for the rules shared by the chains: endpoint fallback, error reasons, stream options, the stateless relayer, transaction statuses, confirmations and signers.
  - `SolanaRpcError` and the Indexer stream options link to the shared description instead of repeating it.
  - The README has an Rpc and Indexer example and a Relayer example, both type-checked.
  - The `SolanaRelayer` header says that `sign` does not use durable nonces, while `fetchTransactionStatus` can follow a durable-nonce transaction signed elsewhere.

- [#83](https://github.com/spiko-tech/effect-blockchain/pull/83) [`be71305`](https://github.com/spiko-tech/effect-blockchain/commit/be71305609118c749c0e38b46d60bcb4c45520eb) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - Pin `@effect-blockchain/core` to the exact version released with this package (`workspace:*`)
  
  - The chain packages use core APIs marked `@internal`, so each release now depends on one exact core version instead of a caret range.
- Updated dependencies [[`5d75cb8`](https://github.com/spiko-tech/effect-blockchain/commit/5d75cb8761d7ed6b8443e74434ee4f9e123a0633), [`2c0d672`](https://github.com/spiko-tech/effect-blockchain/commit/2c0d672c3288722af9019ec503bf9519b1df51cd), [`90ca1fa`](https://github.com/spiko-tech/effect-blockchain/commit/90ca1fa28406bffe7b4d2abc921608f44de8f897)]:
  - @effect-blockchain/core@0.2.0

## 0.2.0

### Minor Changes

- [#67](https://github.com/spiko-tech/effect-blockchain/pull/67) [`7fddf4a`](https://github.com/spiko-tech/effect-blockchain/commit/7fddf4a644175d7965018e1f35c8ccd96be156f7) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - Read the native (lamport) balance of an address.
  
  - `SolanaIndexer.fetchNativeBalance({ address, block })`: the lamports at the end of a slot, from the meta of the address's newest transaction at or before it, or `getBalance` at the confirmed head.
  - `SolanaIndexer.streamNativeBalance({ address, fromBlock, toBlock, step, poll, retry })`: a `SolanaNativeBalance` sample every `step` slots, following the confirmed head.
  - `SolanaRpc.getBalance({ address })` at `finalized` commitment.
  - **Breaking:** `SolanaTransactionInfo.meta` is now a typed `SolanaTransactionMeta | null` (`err`, `fee`, `preBalances`, `postBalances` as `bigint`, `loadedAddresses`) instead of raw JSON with decimal strings; its other fields (logs, token balances, inner instructions...) are dropped. The `SolanaRpc` service gains a required `getBalance` member, so a hand-written implementation needs one.

- [#80](https://github.com/spiko-tech/effect-blockchain/pull/80) [`8312b93`](https://github.com/spiko-tech/effect-blockchain/commit/8312b93ba35bf7cbc787ad37a010c25ab80147ac) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - Sign and broadcast Solana transactions.
  
  - `SolanaRelayer.sign({ feePayer, signers?, instructions, blockhash?, computeUnitLimit?, computeUnitPrice? })` signs a v0 transaction and returns `{ hash, signed, lastValidBlockHeight }` before anything is sent: `hash` is the fee payer's signature and `lastValidBlockHeight` is what `fetchTransactionStatus` and `awaitConfirmation` take. A missing blockhash is the latest one at `confirmed`, a missing compute unit limit is what `simulateTransaction` consumed times `computeUnitMultiplier` (1.2 by default), a missing compute unit price comes from the fee strategy. Both are prepended as Compute Budget instructions. A transaction whose simulation fails fails with `SimulationFailed`.
  - `SolanaRelayer.broadcast({ signed })` sends it with a preflight at `confirmed` and returns its hash. A node that has already processed the transaction is a success. A preflight failure fails with a `SolanaBroadcastError` whose `reason` is `BlockhashNotFound`, `InsufficientFundsForFee` or `SimulationFailed`, which carries the transaction error and the logs.
  - `SolanaRelayer.layer` takes `fees`, a strategy from the `getRecentPrioritizationFees` entries of the accounts the transaction writes to, to a compute unit price in micro-lamports, and `computeUnitMultiplier`. `SolanaRelayer.defaultFees` is the default: the 75th percentile, at least 1 micro-lamport.
  - `SolanaInstruction` and `SolanaAccountMeta` describe the instructions to sign.
  - `SolanaRpc.layer` takes `genesisHash`, which replaces the genesis hash of `network` for a local validator or a private cluster.
  
  The `SolanaRelayer` service gains `sign` and `broadcast`, so a hand-written fake (`SolanaRelayer.of(...)`) needs the two new entries.

- [#75](https://github.com/spiko-tech/effect-blockchain/pull/75) [`7bc8ae6`](https://github.com/spiko-tech/effect-blockchain/commit/7bc8ae68a27b4d0aa339d57e87d3ae4fc142685e) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - Follow a Solana transaction until it is final.
  
  - `SolanaRelayer.fetchTransactionStatus({ hash, lastValidBlockHeight? })` returns `Included { block }`, `Confirmed { block }`, `Failed { block, reason }`, `Expired` or `NotFound`, `block` being the slot. `Confirmed` and `Failed` are only reported for a finalized transaction at or below the last confirmed slot, with the same `confirmations` rule as `SolanaIndexer`. `Pending` is part of the type for parity with the other chains and never reported.
  - `Expired` is reported for an unknown transaction once the finalized block height is above its `lastValidBlockHeight`: it can no longer land.
  - `SolanaRelayer.awaitConfirmation({ hash, lastValidBlockHeight?, poll? })` polls it until `Confirmed`, `Failed` or `Expired`.
  - `SolanaRpc` gains `getSignatureStatuses` and `getBlockHeight`, with the `SolanaSignatureStatus`, `SolanaSignatureStatuses`, `SolanaTransactionError` and `SolanaInstructionError` models.
  
  The `SolanaRpc` service gains members, so a hand-written fake (`SolanaRpc.of(...)`) needs the two new entries.

- [#76](https://github.com/spiko-tech/effect-blockchain/pull/76) [`315df25`](https://github.com/spiko-tech/effect-blockchain/commit/315df257e1d82161c6c30e5c615d8eb2dbbab194) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - Sign Solana transaction messages and add the RPC methods sending needs.
  
  - `SolanaSigner` is an `address` and `signTransactionMessage`, which receives the serialized transaction message and returns its 64-byte ed25519 signature. `SolanaSigner.fromPrivateKey` holds a base58 64-byte secret key in memory. `SolanaSigner.fromMessageSigner({ address, signMessage })` wraps a custody API that signs raw bytes and checks that the signature it returns was made by `address`. Failures are a `SolanaSignerError`.
  - `SolanaRpc.getLatestBlockhash({ commitment })` returns `{ slot, blockhash, lastValidBlockHeight }`.
  - `SolanaRpc.simulateTransaction({ transaction, commitment, sigVerify?, replaceRecentBlockhash? })` returns `{ slot, err, logs, unitsConsumed }` for a base64 wire transaction.
  - `SolanaRpc.getRecentPrioritizationFees({ addresses })` returns the `{ slot, prioritizationFee }` entries of the node's recent slots, in micro-lamports per compute unit.
  - `SolanaRpc.sendTransaction({ transaction, skipPreflight?, preflightCommitment?, maxRetries? })` submits a signed base64 wire transaction and returns its first signature.
  
  The `SolanaRpc` service gains `getLatestBlockhash`, `simulateTransaction`, `getRecentPrioritizationFees` and `sendTransaction`, so a hand-written fake (`SolanaRpc.of(...)`) needs the four new entries.

## 0.1.0

### Minor Changes

- [#58](https://github.com/spiko-tech/effect-blockchain/pull/58) [`b21f4e0`](https://github.com/spiko-tech/effect-blockchain/commit/b21f4e0c73c66efdcd796b98f21dd378357665b0) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - Initial release.
  
  - `SolanaRpc`: typed, read-only Solana JSON-RPC methods over an ordered list of endpoints with fallback.
  - `SolanaIndexer`: the last confirmed slot, the transactions touching an address over a slot range, and a stream of them following the confirmed head.
  - `SolanaNetwork`: named Solana clusters and their genesis hashes.
  - Schemas for `SolanaAddress` and `SolanaTransactionHash`, built on `@solana/kit`.

### Patch Changes

- Updated dependencies [[`b21f4e0`](https://github.com/spiko-tech/effect-blockchain/commit/b21f4e0c73c66efdcd796b98f21dd378357665b0)]:
  - @effect-blockchain/core@0.1.0
