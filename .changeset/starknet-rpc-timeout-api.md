---
"@effect-blockchain/starknet": patch
---

`StarknetRpc` falls back on a timeout at once and takes one params object per method:

- a timed-out attempt is no longer retried on the same endpoint: it fails as `Unavailable` (`timed out after <duration>`) and the call moves to the next endpoint at once. Other transient errors are still retried, the default timeout stays 30 seconds.
- `getTransactionReceipt(transactionHash)` becomes `getTransactionReceipt({ transactionHash })`.
