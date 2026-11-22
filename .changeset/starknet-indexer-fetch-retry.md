---
"@effect-blockchain/starknet": minor
---

Retry transient failures in every `StarknetIndexer` fetch

- `StarknetIndexer.fetchEvents` takes an optional second argument `{ retry }`, and `StarknetIndexer.fetchNativeBalance` takes `retry` in its options. `retry` retries each `starknet_getEvents` page or `starknet_call` failing with a transient reason (`JsonRpc.isTransient`), so a retry keeps the pages already read. A cursor page still failing after its retries restarts its range once, as before. It is off by default.
- The JSDoc of both methods states their request cost.
