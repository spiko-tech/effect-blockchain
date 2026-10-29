---
"@effect-blockchain/solana": patch
---

Add `SolanaRpc`: typed, read-only `getGenesisHash`, `getSlot`, `getSignaturesForAddress` and `getTransaction` over an ordered list of endpoints with fallback, network check by genesis hash, retries and timeouts, on `@solana/kit` 8.5.0's HTTP transport.
