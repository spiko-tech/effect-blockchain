---
"@effect-blockchain/core": patch
---

Naming polish before the first release.

- `JsonRpc.guard` (internal) is renamed `requireHead`.
- `JsonRpc.BigIntFromInt` and `JsonRpc.optionalOmitted` (internal) are new, shared by the chain packages instead of one copy each.
- Docgen source links now point to `packages/core/src/`.
