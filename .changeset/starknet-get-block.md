---
"@effect-blockchain/starknet": patch
---

Adds `StarknetRpc.getBlockWithTxHashes({ blockNumber })` over `starknet_getBlockWithTxHashes`, so a caller can read the block timestamp of its events.

- Adds the `StarknetBlock` schema: `blockNumber`, `blockHash`, `parentHash`, `timestamp` (unix seconds, `bigint`), `status` (`ACCEPTED_ON_L2` or `ACCEPTED_ON_L1`) and the block's `transactions` hashes.
- A pre-confirmed block (no block hash or no accepted status) fails with `InvalidResponse`.
- Only an endpoint whose head has reached `blockNumber` is asked; `BLOCK_NOT_FOUND` (24) fails with `Lagging` and falls back.
- Records Alchemy and Infura fixtures for block 1380308 (the EUTBL receipt fixture's block).
- Adding a method to the `StarknetRpc` service type breaks hand-written implementations of it (test fakes), which must add `getBlockWithTxHashes`.
