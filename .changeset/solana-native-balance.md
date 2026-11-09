---
"@effect-blockchain/solana": minor
---

Read the native (lamport) balance of an address.

- `SolanaIndexer.fetchNativeBalance({ address, block })`: the lamports at the end of a slot, from the meta of the address's newest transaction at or before it, or `getBalance` at the confirmed head.
- `SolanaIndexer.streamNativeBalance({ address, fromBlock, toBlock, step, poll, retry })`: a `SolanaNativeBalance` sample every `step` slots, following the confirmed head.
- `SolanaRpc.getBalance({ address })` at `finalized` commitment.
- **Breaking:** `SolanaTransactionInfo.meta` is now a typed `SolanaTransactionMeta | null` (`err`, `fee`, `preBalances`, `postBalances` as `bigint`, `loadedAddresses`) instead of raw JSON with decimal strings; its other fields (logs, token balances, inner instructions...) are dropped. The `SolanaRpc` service gains a required `getBalance` member, so a hand-written implementation needs one.
