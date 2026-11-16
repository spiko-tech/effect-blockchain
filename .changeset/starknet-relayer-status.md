---
"@effect-blockchain/starknet": minor
---

Follow a Starknet transaction until it is final.

- `StarknetRelayer.fetchTransactionStatus({ hash })` returns `Pending`, `Included { block }`, `Confirmed { block }`, `Failed { block, reason }` or `NotFound`. A received, candidate or pre-confirmed transaction is `Pending`. `Confirmed` and `Failed` are only reported at or below the last confirmed block, with the same `confirmations` rule as `StarknetIndexer`, and `reason` is the node's revert message.
- `StarknetRelayer.awaitConfirmation({ hash, poll? })` polls it until `Confirmed` or `Failed`.
- `StarknetRpc.getTransactionStatus({ transactionHash })` over `starknet_getTransactionStatus` (JSON-RPC spec v0.9), with the `StarknetTransactionStatusResult` model. It returns `null` when the last endpoint tried answers `TXN_HASH_NOT_FOUND`.

The `StarknetRpc` service gains a member, so a hand-written fake (`StarknetRpc.of(...)`) needs a `getTransactionStatus` entry.
