---
"@effect-blockchain/stellar": minor
---

Follow a Stellar transaction until it is final.

- `StellarRelayer.fetchTransactionStatus({ hash, maxLedger? })` returns `Included { block }`, `Confirmed { block }`, `Failed { block, reason }`, `Expired` or `NotFound` (`Pending` is kept for parity with the other chains and never reported: Stellar RPC only knows closed ledgers). `block` is the ledger sequence. `Confirmed` and `Failed` are only reported at or below the last confirmed ledger, with the same `confirmations` rule as `StellarIndexer`.
- `Failed.reason` is a `StellarTransactionFailure`: the transaction result code (`txFailed`, `txBadSeq`, `txInsufficientFee`...) and, for `txFailed`, the result code of each operation (`paymentUnderfunded`, `opNoAccount`...), typed by the `StellarTransactionResultCode` and `StellarOperationResultCode` schemas.
- `Expired` is final: the transaction is unknown and the node's latest ledger is above `maxLedger`, the upper bound of the transaction's `ledgerBounds`.
- `StellarRelayer.awaitConfirmation({ hash, maxLedger?, poll? })` polls it until `Confirmed`, `Failed` or `Expired`.
- `StellarRpc.getTransaction({ hash })` over `getTransaction`, with the `StellarTransactionInfo` model. A node only holds the transactions of the ledgers it retains: an older one is `NOT_FOUND`.

The `StellarRpc` service gains a member, so a hand-written fake (`StellarRpc.of(...)`) needs a `getTransaction` entry.
