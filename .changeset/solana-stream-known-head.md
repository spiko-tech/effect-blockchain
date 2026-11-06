---
"@effect-blockchain/solana": patch
---

`SolanaIndexer.streamTransactions` documents that it reads the confirmed head once per catch-up.

- Docs only: the stream already reads `getSlot` once per catch-up segment (one signature listing up to the head, then its groups), so the code is unchanged.
