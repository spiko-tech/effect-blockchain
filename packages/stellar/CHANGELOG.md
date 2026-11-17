# @effect-blockchain/stellar

## 0.4.0

### Minor Changes

- [#93](https://github.com/spiko-tech/effect-blockchain/pull/93) [`36166d6`](https://github.com/spiko-tech/effect-blockchain/commit/36166d6e89c51bcca14cedf01d6d8bea5e3e5cb5) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - Read old native balances from the endpoints flagged `archive`
  
  - `StellarIndexer.fetchNativeBalance` and `streamNativeBalance` read a `getLedgers` page again from the endpoints flagged `archive` when the regular endpoints fail it `Pruned`, so a `block` older than their retention no longer fails. With no endpoint flagged `archive`, the `Pruned` error stands.

## 0.3.0

### Minor Changes

- [#92](https://github.com/spiko-tech/effect-blockchain/pull/92) [`8b4d3ac`](https://github.com/spiko-tech/effect-blockchain/commit/8b4d3acd78b16244e9a5172d0886ec9b5ded5cba) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - `StellarIndexer.fetchArchivedEvents` reads contract events older than a regular endpoint's retention from the archive endpoints.
  
  - `fetchArchivedEvents({ filter, fromBlock, toBlock, concurrency?, retry? })` returns a `StellarIndexerBatch`. It pages `getLedgers` on the endpoints flagged `archive` and decodes each `LedgerCloseMeta` (`TransactionMeta` v3 and v4) into the contract events `getEvents` returns, ids included, with the same contract and topic filter. Events of failed transactions are left out.
  - `LEDGERS_PAGE_SIZE` (10) is the `getLedgers` page size of the Indexer, and `StellarIndexerArchivedEventsOptions` the options type.

- [#88](https://github.com/spiko-tech/effect-blockchain/pull/88) [`2f4d949`](https://github.com/spiko-tech/effect-blockchain/commit/2f4d949a8669e43d6b96a7a008fc984591dc94cb) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - Align `StellarRelayer` and `StellarSigner` with the other chains, and stop two ways a transaction could fail late.
  
  - `sign` fails with a `StellarSimulationError` of reason `RestoreRequired` (`transactionData`, `minResourceFee`) when the simulation returns a `restorePreamble`. It used to sign the invocation, which then failed in a ledger and paid its fee. `StellarRpc.simulateTransaction` now returns `restorePreamble`.
  - A result code this version does not list no longer throws inside `broadcast` and `fetchTransactionStatus`: it reads `undefined`.
  - New `StellarRelayer.layerConfig` (`confirmations`, `validity`), `StellarFees`, `StellarFeeEstimate` and `StellarTransactionStatusOptions`.
  - `StellarBroadcastError` has a `cause` holding the node's reply.
  - Breaking: `feeBump` returns a full `StellarSignedTransaction` (`hash`, `signed`, `sequence`, `maxLedger` of the inner transaction) instead of `{ hash, signed }`, so `awaitConfirmation(bumped)` can end in `Expired`.
  - Breaking: `sign({ fee })` and `feeBump({ fee })` are replaced by `fees: { fee }` (`StellarFees`, stroops per operation).
  - Breaking: `defaultFees` and the `fees` option of `layer` are `(estimate: StellarFeeEstimate) => StellarFees` instead of `(inclusionFee: StellarFeeDistribution) => bigint`.
  - Breaking: a `txBadSeq` refusal is the reason `InvalidNonce` and a `txInsufficientBalance` refusal is `InsufficientFunds`, instead of `Refused` with that `code`. `Refused` keeps the other codes.
  - Breaking: `StellarTransactionFailure.code` and each entry of `operations` (also on `Refused`) can be `undefined`.
  - Breaking: `StellarSigner.fromPrivateKey({ key })` replaces `fromPrivateKey(key)`.

- [#90](https://github.com/spiko-tech/effect-blockchain/pull/90) [`2c0d672`](https://github.com/spiko-tech/effect-blockchain/commit/2c0d672c3288722af9019ec503bf9519b1df51cd) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - `StellarRpc.getLedgers` returns one page with its cursor, and endpoints can be flagged `archive`.
  
  - Breaking: `getLedgers` returns a `StellarLedgersPage` (`{ ledgers, cursor, latestLedger, oldestLedger }`) instead of `ReadonlyArray<StellarLedger>`. Read `page.ledgers` where the array was used.
  - `getLedgers` takes `{ startLedger, limit? }` or `{ cursor, limit? }` (`StellarLedgersOptions`). A `StellarLedgersCursor` is only sent to the endpoint that issued it, with no fallback, like a `getEvents` cursor.
  - A page that does not start at the requested ledger or that skips a ledger fails `InvalidResponse`. A cursor the endpoint no longer retains fails `Pruned`.
  - `StellarRpcEndpoint` gains `archive?: boolean`, also read by `layerConfig`. `getLedgers({ startLedger, archive: true })` only asks the endpoints flagged `archive`, in their configured order, and fails `Rejected` without a request when none is flagged. Every other call still goes through all the endpoints.

- [#85](https://github.com/spiko-tech/effect-blockchain/pull/85) [`5d75cb8`](https://github.com/spiko-tech/effect-blockchain/commit/5d75cb8761d7ed6b8443e74434ee4f9e123a0633) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - `StellarRelayer.awaitConfirmation` no longer ends on a transient RPC error.
  
  - A status read failing with a transient reason (`JsonRpc.isTransient`: `Unavailable`, `InvalidResponse`, `Lagging`) is read again on `poll`. It used to fail the wait, leaving the caller unable to tell whether the transaction landed. Any other error still fails the wait, and a `poll` that ends first returns the last read.
  - `StellarRelayer.DEFAULT_POLL_INTERVAL` is exported, the same value as `StellarIndexer.DEFAULT_POLL_INTERVAL`.

### Patch Changes

- [#91](https://github.com/spiko-tech/effect-blockchain/pull/91) [`90ca1fa`](https://github.com/spiko-tech/effect-blockchain/commit/90ca1fa28406bffe7b4d2abc921608f44de8f897) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - Shorten the module docs and document the shared semantics once
  
  - Module headers are 1 to 3 sentences with one `@example`, and link to `docs/concepts.md` for the rules shared by the chains: endpoint fallback, error reasons, stream options, the stateless relayer, transaction statuses, confirmations and signers.
  - `StellarRpcError` and the Indexer stream options link to the shared description instead of repeating it.
  - The README has an Rpc and Indexer example and a Relayer example, both type-checked.
  - `StellarRelayer.sign` documents `UnsupportedAuth` and the authorization entries passed by the caller, which are kept.
  - `StellarRpc` documents what a node answers to a second copy of a transaction: `DUPLICATE`, then `TRY_AGAIN_LATER`, then `txBadSeq`.
  - `StellarRpcEndpoint` no longer says that endpoint names must be unique: a cursor goes to the first endpoint with the name of the one that issued it.
  - The channel account and fee bump sample moved from the module header to the `@example` of `feeBump`.

- [#83](https://github.com/spiko-tech/effect-blockchain/pull/83) [`be71305`](https://github.com/spiko-tech/effect-blockchain/commit/be71305609118c749c0e38b46d60bcb4c45520eb) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - Pin `@effect-blockchain/core` to the exact version released with this package (`workspace:*`)
  
  - The chain packages use core APIs marked `@internal`, so each release now depends on one exact core version instead of a caret range.
- Updated dependencies [[`5d75cb8`](https://github.com/spiko-tech/effect-blockchain/commit/5d75cb8761d7ed6b8443e74434ee4f9e123a0633), [`2c0d672`](https://github.com/spiko-tech/effect-blockchain/commit/2c0d672c3288722af9019ec503bf9519b1df51cd), [`90ca1fa`](https://github.com/spiko-tech/effect-blockchain/commit/90ca1fa28406bffe7b4d2abc921608f44de8f897)]:
  - @effect-blockchain/core@0.2.0

## 0.2.0

### Minor Changes

- [#68](https://github.com/spiko-tech/effect-blockchain/pull/68) [`8597f19`](https://github.com/spiko-tech/effect-blockchain/commit/8597f1979e24aee0420a3e9c470f33ecf7f197b6) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - Index the native (XLM) balance of an account.
  
  - `StellarIndexer.fetchNativeBalance({ address, block })`: the balance in stroops at the end of a ledger.
  - `StellarIndexer.streamNativeBalance({ address, fromBlock, toBlock?, step, poll?, retry? })`: a `StellarNativeBalance` sample every `step` ledgers, following the confirmed head.
  - `StellarRpc.getLedgers` (ledger metas, raw base64 XDR, falling back from `Pruned` to an archive endpoint) and `StellarRpc.getLedgerEntries` (raw base64 entries at the head, failing `Lagging` below `minLedger`).
  - History is read from the ledger metas of `getLedgers`, 1 to 3 MB per mainnet ledger: `step` does not reduce these reads.
  - An account missing at the head reads `0` at every ledger, even if it was merged later.
  - The `StellarRpc` service gains `getLedgers` and `getLedgerEntries`: a hand-written `StellarRpc` implementation (a test fake, for example) needs both.

- [#82](https://github.com/spiko-tech/effect-blockchain/pull/82) [`06c09d3`](https://github.com/spiko-tech/effect-blockchain/commit/06c09d3d3b6191f045d71991677dd1ec536f9bf0) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - Channel accounts and sponsored account creation on Stellar.
  
  - `StellarRelayer.sign` takes a `channel`: the transaction uses the channel's sequence number and balance, its operations without a source account act for `signer`, and both sign. Several transactions of one account can then be in flight at once, one per channel. Wrapping the result with `feeBump` makes one funded account pay for every channel.
  - `StellarRelayer.sign` takes `cosigners`, the signers of the operations whose source is another account.
  - `StellarRelayer.createSponsoredAccount({ sponsor, account })` returns the three operations creating an account whose reserve is paid by its sponsor, for `sign` with the new account as a cosigner.
  - `StellarLedgerEntry` gains `extXdr`, the `LedgerEntryExt` XDR that `getLedgerEntries` returns on recent nodes: it holds the sponsor of the entry.

- [#77](https://github.com/spiko-tech/effect-blockchain/pull/77) [`e097ada`](https://github.com/spiko-tech/effect-blockchain/commit/e097ada7f4d12da2dd10cf869e44a51df540c089) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - Sign and broadcast Stellar transactions.
  
  - `StellarSigner`: a signer is `{ address, signTransaction }` and signs a whole transaction or fee bump envelope. `fromPrivateKey(seed)` holds an `S...` secret seed, `fromHashSigner({ address, signHash })` wraps a custody API that only signs the transaction hash. Failures are a `StellarSignerError`.
  - `StellarRelayer.sign({ signer, operations, sequence?, fee?, maxLedger? })` signs a transaction of classic operations (base64 `Operation` XDR) and returns `{ hash, signed, sequence, maxLedger }` before anything is sent. A missing sequence is the account's sequence number plus 1, a missing fee per operation comes from the fee strategy, a missing `maxLedger` is the latest ledger plus `validity`.
  - `StellarRelayer.broadcast({ signed })` sends the envelope and returns its hash. A node that already holds the transaction, or has it in a ledger, is a success. `TRY_AGAIN_LATER` and a refusal fail with a `StellarBroadcastError` whose `reason` is `TryAgainLater` or `Refused`, with the result code (`txBadSeq`, `txInsufficientFee`...).
  - `StellarRelayer.layer` takes `fees`, a strategy from the classic inclusion fees of `getFeeStats` to a fee per operation, and `validity` (60 ledgers by default). `StellarRelayer.defaultFees` is the default: the 90th percentile, at least 100 stroops.
  - `StellarRpc` gains `getFeeStats` and `sendTransaction`.
  - `StellarNetwork` gains `StellarStandalone`, the local network of `stellar/quickstart --local`.
  
  The `StellarRpc` service gains `getFeeStats` and `sendTransaction`, and the `StellarRelayer` service `sign` and `broadcast`: a hand-written fake (`StellarRpc.of(...)`, `StellarRelayer.of(...)`) needs the new entries. Code matching every `StellarNetwork` needs a `StellarStandalone` case.

- [#81](https://github.com/spiko-tech/effect-blockchain/pull/81) [`7013f22`](https://github.com/spiko-tech/effect-blockchain/commit/7013f2244a28c9673cc8cfdee3df0ecf7f38be2f) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - Sign Soroban invocations and fee bumps on Stellar.
  
  - `StellarRelayer.sign` simulates a transaction of one `invokeHostFunction` operation and gives it its footprint, its resource fee and its authorization entries. Its fee per operation comes from the Soroban inclusion fees of `getFeeStats`. A failed simulation, or an entry another address must sign, fails with a `StellarSimulationError` whose `reason` is `SimulationFailed` or `UnsupportedAuth`.
  - `StellarRelayer.feeBump({ signer, signed, fee? })` wraps a signed transaction in a fee bump paid by `signer` and returns `{ hash, signed }`, with the hash of the fee bump. A missing fee comes from the fee strategy, and is at least the fee of the inner transaction.
  - `StellarRpc` gains `simulateTransaction`.
  - `StellarRpc.sendTransaction` fails `InvalidResponse` when the node answers for another hash than the envelope's, and `Rejected` without a request when the envelope is not XDR.
  
  The `StellarRpc` service gains `simulateTransaction` and the `StellarRelayer` service `feeBump`: a hand-written fake (`StellarRpc.of(...)`, `StellarRelayer.of(...)`) needs the new entries. `StellarRelayer.sign` can now fail with a `StellarSimulationError`.

- [#74](https://github.com/spiko-tech/effect-blockchain/pull/74) [`ea6c8a7`](https://github.com/spiko-tech/effect-blockchain/commit/ea6c8a73948570dc6cadb05f5941347ea3a12745) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - Follow a Stellar transaction until it is final.
  
  - `StellarRelayer.fetchTransactionStatus({ hash, maxLedger? })` returns `Included { block }`, `Confirmed { block }`, `Failed { block, reason }`, `Expired` or `NotFound` (`Pending` is kept for parity with the other chains and never reported: Stellar RPC only knows closed ledgers). `block` is the ledger sequence. `Confirmed` and `Failed` are only reported at or below the last confirmed ledger, with the same `confirmations` rule as `StellarIndexer`.
  - `Failed.reason` is a `StellarTransactionFailure`: the transaction result code (`txFailed`, `txBadSeq`, `txInsufficientFee`...) and, for `txFailed`, the result code of each operation (`paymentUnderfunded`, `opNoAccount`...), typed by the `StellarTransactionResultCode` and `StellarOperationResultCode` schemas.
  - `Expired` is final: the transaction is unknown and the node's latest ledger is above `maxLedger`, the upper bound of the transaction's `ledgerBounds`.
  - `StellarRelayer.awaitConfirmation({ hash, maxLedger?, poll? })` polls it until `Confirmed`, `Failed` or `Expired`.
  - `StellarRpc.getTransaction({ hash })` over `getTransaction`, with the `StellarTransactionInfo` model. A node only holds the transactions of the ledgers it retains: an older one is `NOT_FOUND`.
  
  The `StellarRpc` service gains a member, so a hand-written fake (`StellarRpc.of(...)`) needs a `getTransaction` entry.

## 0.1.0

### Minor Changes

- [#58](https://github.com/spiko-tech/effect-blockchain/pull/58) [`b21f4e0`](https://github.com/spiko-tech/effect-blockchain/commit/b21f4e0c73c66efdcd796b98f21dd378357665b0) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - Initial release.
  
  - `StellarRpc`: typed, read-only Stellar RPC methods over an ordered list of endpoints with fallback.
  - `StellarIndexer`: the last confirmed ledger, the Soroban contract events of a set of contracts over a ledger range, and a stream of them following the confirmed head.
  - `StellarNetwork`: named Stellar networks and their passphrases.
  - Schemas for `StellarAddress` (account and contract strkeys), `StellarContractEvent` and `StellarTransactionHash`, built on `@stellar/stellar-sdk`.

### Patch Changes

- Updated dependencies [[`b21f4e0`](https://github.com/spiko-tech/effect-blockchain/commit/b21f4e0c73c66efdcd796b98f21dd378357665b0)]:
  - @effect-blockchain/core@0.1.0
