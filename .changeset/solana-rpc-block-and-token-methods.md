---
"@effect-blockchain/solana": minor
---

Add `getBlockTime`, `getBlocksWithLimit` and `getTokenAccountsByOwner` to `SolanaRpc`.

- `SolanaRpc.getBlockTime({ slot })` returns the estimated production time of a block in Unix seconds, `null` when the node has no time for it. A skipped slot fails `Pruned` and a slot not produced yet fails `Lagging`.
- `SolanaRpc.getBlocksWithLimit({ startSlot, limit, commitment })` returns the produced slots from `startSlot` on, at most `limit`. A `limit` above 500,000 fails `Rejected` before any request.
- `SolanaRpc.getTokenAccountsByOwner({ owner, filter, commitment, minContextSlot? })` returns `{ slot, value }`, the token accounts of `owner` by `mint` or `programId` without their data, with the `SolanaTokenAccount` and `SolanaTokenAccounts` models.

The `SolanaRpc` service gains members, so a hand-written fake (`SolanaRpc.of(...)`) needs the three new entries.
