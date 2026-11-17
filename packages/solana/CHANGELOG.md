# @effect-blockchain/solana

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
