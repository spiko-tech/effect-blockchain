---
"@effect-blockchain/solana": patch
---

Documents that some providers ignore `minContextSlot`. The behaviour is unchanged.

- `SolanaSignaturesQuery.minContextSlot` now says an endpoint that honours it answers `Lagging` until it reaches the slot, that Alchemy ignores it (recorded on 2026-11-03), and that a caller needing the guarantee must check the head itself, e.g. by comparing `getSlot` across endpoints.
- The `Lagging` row of the `SolanaRpcError` reason table notes it only comes from providers that honour `minContextSlot`.
