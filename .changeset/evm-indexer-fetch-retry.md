---
"@effect-blockchain/evm": minor
---

Retry transient failures in every `EvmIndexer` fetch

- `EvmIndexer.fetchLogs` takes an optional second argument `{ retry }`, and `EvmIndexer.fetchNativeBalance` takes `retry` in its options. `retry` retries each `eth_getLogs` or `eth_getBalance` failing with a transient reason (`JsonRpc.isTransient`), so a retry keeps the ranges already read. It is off by default.
- The JSDoc of both methods states their request cost.
