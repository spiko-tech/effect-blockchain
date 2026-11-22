---
"@effect-blockchain/stellar": minor
---

Hop to the archive endpoints when any regular endpoint failed `Pruned`

- `StellarIndexer` reads a ledger from the endpoints flagged `archive` when one of the regular endpoints failed `Pruned`, even when an earlier one failed with a transient reason and the call reports that reason (`@effect-blockchain/core` fallback rule).
