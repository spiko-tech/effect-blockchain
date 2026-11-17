---
"@effect-blockchain/evm": minor
---

`EvmRelayer.awaitConfirmation` no longer ends on a transient RPC error.

- A status read failing with a transient reason (`JsonRpc.isTransient`: `Unavailable`, `InvalidResponse`, `Lagging`) is read again on `poll`. It used to fail the wait, leaving the caller unable to tell whether the transaction landed. Any other error still fails the wait, and a `poll` that ends first returns the last read.
- `EvmRelayer.DEFAULT_POLL_INTERVAL` is exported, the same value as `EvmIndexer.DEFAULT_POLL_INTERVAL`.
