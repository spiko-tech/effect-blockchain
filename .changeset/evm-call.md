---
"@effect-blockchain/evm": minor
---

Add `EvmRpc.call` in `@effect-blockchain/evm` 0.5.0

- `EvmRpc.call({ to, data, from, blockTag })` sends `eth_call` and returns the call's return data as `EvmHexData`, with the same endpoint fallback, retries and error reasons as the other methods.
- A call that reverts fails with `Rejected` and the node's code (3 on geth and its forks) and message.
