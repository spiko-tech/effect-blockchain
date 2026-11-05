---
"@effect-blockchain/evm": patch
---

`EvmIndexer.streamLogs` no longer wraps the whole stream in a span.

- Removes the `EvmIndexer.streamLogs` span: on a live stream it never closed and every step span piled up under it. Each step still runs under the `EvmIndexer.lastConfirmedBlock` and `EvmIndexer.fetchLogs` spans.
- Documents that one stream per (network, filter) runs at a time and that the caller provides the exclusivity, for example with a Postgres advisory lock.
- Tests a step whose `lastConfirmedBlock` fails with `Unavailable`: it is retried at the same block and the stream continues.
