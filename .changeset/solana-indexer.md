---
"@effect-blockchain/solana": patch
---

Adds `SolanaIndexer`, raw indexing of the transactions touching one address on top of `SolanaRpc`.

- Adds `SolanaIndexer`: `lastConfirmedBlock` (the `finalized` slot minus the confirmations) and `fetchTransactions({ address, fromBlock, toBlock })`, which pages `getSignaturesForAddress` at `finalized` (1000 per page, `minContextSlot: toBlock`) from the head down to `fromBlock`, keeps the slots in range, then calls `getTransaction` for each, in chain order. Failed transactions are kept with their raw `err`.
- Adds `SolanaNetwork.defaultConfirmations`: 0 on every network, `finalized` already waits for 31+ confirmed blocks.
