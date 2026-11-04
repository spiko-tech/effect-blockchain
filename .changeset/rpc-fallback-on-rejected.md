---
"@effect-blockchain/core": patch
"@effect-blockchain/evm": patch
"@effect-blockchain/solana": patch
"@effect-blockchain/starknet": patch
"@effect-blockchain/stellar": patch
---

A `Rejected` call now falls back to the next endpoint. Only `WrongNetwork` stops the fallback at once.

- Providers disagree on limits: Infura refuses an `eth_getLogs` range above its plan with HTTP 200 `-32602` ("range 10009 exceeds limit of 10000"), a reply another endpoint may not give. It used to stop the call.
- `Rejected` is still not retried on the same endpoint. A request every endpoint refuses (bad params) costs one request per endpoint and ends with the last endpoint's `Rejected`, its `cause` an `AggregateError` of every endpoint's error.
- A call that continues a cursor (Starknet, Stellar `getEvents`) stays pinned to the endpoint that issued it.
- The reason tables of `JsonRpc` and each chain's error now mark `Rejected` as falling back.
