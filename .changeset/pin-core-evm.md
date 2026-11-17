---
"@effect-blockchain/evm": patch
---

Pin `@effect-blockchain/core` to the exact version released with this package (`workspace:*`)

- The chain packages use core APIs marked `@internal`, so each release now depends on one exact core version instead of a caret range.
