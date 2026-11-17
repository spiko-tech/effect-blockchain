---
"@effect-blockchain/starknet": patch
---

Pin `@effect-blockchain/core` to the exact version released with this package (`workspace:*`)

- The chain packages use core APIs marked `@internal`, so each release now depends on one exact core version instead of a caret range.
- The `starknet` peer dependency is now optional: only `StarknetRelayer` and `StarknetSigner` import it. Import `StarknetRpc` and `StarknetIndexer` by subpath when it is not installed.
