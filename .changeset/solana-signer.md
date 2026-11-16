---
"@effect-blockchain/solana": minor
---

Sign Solana transaction messages and add the RPC methods sending needs.

- `SolanaSigner` is an `address` and `signTransactionMessage`, which receives the serialized transaction message and returns its 64-byte ed25519 signature. `SolanaSigner.fromPrivateKey` holds a base58 64-byte secret key in memory. `SolanaSigner.fromMessageSigner({ address, signMessage })` wraps a custody API that signs raw bytes and checks that the signature it returns was made by `address`. Failures are a `SolanaSignerError`.
- `SolanaRpc.getLatestBlockhash({ commitment })` returns `{ slot, blockhash, lastValidBlockHeight }`.
- `SolanaRpc.simulateTransaction({ transaction, commitment, sigVerify?, replaceRecentBlockhash? })` returns `{ slot, err, logs, unitsConsumed }` for a base64 wire transaction.
- `SolanaRpc.getRecentPrioritizationFees({ addresses })` returns the `{ slot, prioritizationFee }` entries of the node's recent slots, in micro-lamports per compute unit.
- `SolanaRpc.sendTransaction({ transaction, skipPreflight?, preflightCommitment?, maxRetries? })` submits a signed base64 wire transaction and returns its first signature.

The `SolanaRpc` service gains `getLatestBlockhash`, `simulateTransaction`, `getRecentPrioritizationFees` and `sendTransaction`, so a hand-written fake (`SolanaRpc.of(...)`) needs the four new entries.
