---
"@effect-blockchain/evm": patch
---

`EvmRpc` tests now replay real Ethereum mainnet replies from Alchemy and Infura. The library is unchanged.

- Adds `scripts/record-fixtures.ts` (`pnpm record-fixtures`): pinned `eth_chainId`, `eth_blockNumber` and `eth_getLogs` requests (EUTBL and USTBL Transfer logs in blocks 26083549..26083558, a range too large, a range beyond the head, invalid params, an invalid key), saved as URL-free and key-free fixtures.
- Adds `test/EvmRpc.fixtures.test.ts`: each fixture replayed through the real `EvmRpc.layer`, plus an Alchemy-to-Infura fallback.
- Records one gap as `it.fails`: Infura's range limit (`-32602`, "range 10009 exceeds limit of 10000") maps to `Rejected` and stops the fallback.
