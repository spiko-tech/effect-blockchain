---
"@effect-blockchain/evm": patch
---

Add `EvmRpc.getBlockByNumber`, so a caller can date its logs.

- `getBlockByNumber({ blockNumber })` calls `eth_getBlockByNumber` without the transactions and returns the new `EvmBlock` model: `number`, `hash`, `parentHash` and `timestamp` (Unix seconds), other fields ignored.
- The head guard applies as in `getLogs`: an endpoint whose head is below the block fails `Lagging` and the call falls back. A `null` block below the head is also `Lagging` (a backend node behind the provider's head), and a block with another `number` is `InvalidResponse`.
- New fixtures: Alchemy and Infura replies for mainnet block 26083549.
