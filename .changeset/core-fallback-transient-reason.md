---
"@effect-blockchain/core": minor
---

Keep the transient reason when endpoints fail in sequence

- When several endpoints fail, the `<Chain>RpcError` takes its `reason`, `method`, `endpoint` and `code` from the last error with a transient reason (`JsonRpc.isTransient`), else from the last error. A call that failed `Pruned` after an earlier transient failure now fails with the transient reason, so a `retry` that runs only while the reason is transient retries it.
- `cause` still holds every endpoint's error in order, `WrongNetwork` still stops the fallback at once, and a single endpoint's error is unchanged.
