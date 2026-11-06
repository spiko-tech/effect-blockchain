---
"@effect-blockchain/solana": minor
---

Initial release.

- `SolanaRpc`: typed, read-only Solana JSON-RPC methods over an ordered list of endpoints with fallback.
- `SolanaIndexer`: the last confirmed slot, the transactions touching an address over a slot range, and a stream of them following the confirmed head.
- `SolanaNetwork`: named Solana clusters and their genesis hashes.
- Schemas for `SolanaAddress` and `SolanaTransactionHash`, built on `@solana/kit`.
