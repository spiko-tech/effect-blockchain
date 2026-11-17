# @effect-blockchain/stellar

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
