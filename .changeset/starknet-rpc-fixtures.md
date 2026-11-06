---
"@effect-blockchain/starknet": patch
---

`StarknetRpc` tests now replay real Alchemy and Infura Starknet mainnet replies (RPC spec 0.9.0) through the real layer. No API change.

- Adds `scripts/record-fixtures.ts` (`pnpm record-fixtures`), which records pinned requests into `test/fixtures/<provider>/<case>.json` and fails when a fixture contains a key or a provider URL.
- Covers `starknet_chainId`, `starknet_blockNumber`, two `starknet_getEvents` pages on a tokenized fund token (blocks 1380300 to 1380400, `chunk_size` 5), `starknet_getTransactionReceipt`, a `to_block` beyond the head, `PAGE_SIZE_TOO_BIG` (31), `INVALID_CONTINUATION_TOKEN` (33), an invalid API key (HTTP 401) and the fallback from an invalid key to the next endpoint.
- Type-checks `packages/*/scripts` with the tests.
