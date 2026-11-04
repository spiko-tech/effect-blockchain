---
"@effect-blockchain/starknet": patch
---

Adds `StarknetIndexer`, which reads every confirmed event of a contract over a block range on top of `StarknetRpc`.

- Adds `StarknetIndexer`: `lastConfirmedBlock` (head minus confirmations, never below 0) and `fetchEvents` (a `starknet_getEvents` filter without `chunkSize` and `cursor`), reading chunks of at most `maxBlockRange` blocks (default `DEFAULT_MAX_BLOCK_RANGE`, 10000) and paging each chunk with its continuation token. A failed cursor page restarts its chunk once through the fallback chain; a second failure fails the call.
- Adds `StarknetNetwork.defaultConfirmations`: 0 on Starknet and Starknet Sepolia, as `ACCEPTED_ON_L2` blocks are final.
