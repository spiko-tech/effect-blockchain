---
"@effect-blockchain/starknet": patch
---

`StarknetIndexer.streamEvents` reads the confirmed head once per catch-up.

- The stream position keeps the last confirmed head read: a step whose next block is at or below it fetches the next batch directly, and `lastConfirmedBlock` is read only when the stream reaches that head. A catch-up over N batches makes one `starknet_blockNumber` call where it made N.
- Batches, `toBlock`, `poll`, `retry` and spans are unchanged.
