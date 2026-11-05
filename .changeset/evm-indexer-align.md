---
"@effect-blockchain/evm": patch
---

Aligns `EvmIndexer` with the other chain indexers.

- Adds tracing spans: `EvmIndexer.lastConfirmedBlock` and `EvmIndexer.fetchLogs`.
