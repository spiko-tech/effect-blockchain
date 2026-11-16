---
"@effect-blockchain/solana": minor
---

Follow a Solana transaction until it is final.

- `SolanaRelayer.fetchTransactionStatus({ hash, lastValidBlockHeight? })` returns `Included { block }`, `Confirmed { block }`, `Failed { block, reason }`, `Expired` or `NotFound`, `block` being the slot. `Confirmed` and `Failed` are only reported for a finalized transaction at or below the last confirmed slot, with the same `confirmations` rule as `SolanaIndexer`. `Pending` is part of the type for parity with the other chains and never reported.
- `Expired` is reported for an unknown transaction once the finalized block height is above its `lastValidBlockHeight`: it can no longer land.
- `SolanaRelayer.awaitConfirmation({ hash, lastValidBlockHeight?, poll? })` polls it until `Confirmed`, `Failed` or `Expired`.
- `SolanaRpc` gains `getSignatureStatuses` and `getBlockHeight`, with the `SolanaSignatureStatus`, `SolanaSignatureStatuses`, `SolanaTransactionError` and `SolanaInstructionError` models.

The `SolanaRpc` service gains members, so a hand-written fake (`SolanaRpc.of(...)`) needs the two new entries.
