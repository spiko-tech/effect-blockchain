---
"@effect-blockchain/starknet": minor
---

`StarknetRelayer.awaitConfirmation` no longer ends on a transient RPC error.

- A status read failing with a transient reason (`JsonRpc.isTransient`: `Unavailable`, `InvalidResponse`, `Lagging`) is read again on `poll`. It used to fail the wait, leaving the caller unable to tell whether the transaction landed. Any other error still fails the wait, and a `poll` that ends first returns the last read.
- `StarknetRelayer.DEFAULT_POLL_INTERVAL` is exported, the same value as `StarknetIndexer.DEFAULT_POLL_INTERVAL`.
