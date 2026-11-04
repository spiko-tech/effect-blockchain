---
"@effect-blockchain/evm": patch
---

`EvmRpc.getLogs` falls back to the next endpoint when a provider refuses the block range as above its plan limit.

- A `-32602` reply whose message is a range limit (Infura "range 10009 exceeds limit of 10000", Alchemy "block range") is now `Unavailable` instead of `Rejected`, with the same `code`, `method`, `endpoint` and `cause`. It is not retried on the same endpoint.
- A `-32602` on a malformed filter ("Invalid params", "data type size mismatch") stays `Rejected`, and every other error is unchanged.
- The `it.fails` fixture test for Infura's range limit now passes, plus an Infura-to-Alchemy fallback test on the recorded range-too-large replies.
