---
"@effect-blockchain/evm": patch
---

`EvmRpc` no longer retries a timed-out attempt on the same endpoint, and its API is aligned with the other chains.

- A timed-out attempt is no longer retried: it fails at once as `Unavailable` and the call moves to the next endpoint. A hanging endpoint used to cost 4 x 30 seconds plus backoff before the fallback. Transport errors, HTTP 408/429/5xx and the transient JSON-RPC codes are still retried.
- `EvmRpc.chainId` now returns the branded `EvmChainId` instead of `number`.
- `EvmLogFilter` is renamed `EvmLogsFilter`.
