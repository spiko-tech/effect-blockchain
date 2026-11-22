---
"@effect-blockchain/solana": minor
---

Read native balances at many blocks in one call

- `SolanaIndexer.fetchNativeBalances({ address, blocks, retry? })` returns the balances in the order of `blocks`. It lists the signatures of the address once, down to the lowest block, and reads each distinct transaction once, so a balance history costs requests in proportion to its changes.
- `SolanaIndexer.fetchNativeBalance` reads through `fetchNativeBalances` with one block, with the same answers and requests as before.
