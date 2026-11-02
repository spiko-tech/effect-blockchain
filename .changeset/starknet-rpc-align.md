---
"@effect-blockchain/starknet": patch
---

Align `StarknetRpc` with the shared RPC rules:

- rename `StarknetEventFilter` to `StarknetEventsFilter`
- rename the `StarknetEventsCursor` field `continuationToken` to `cursor`
- a cursor from an unknown endpoint fails `Rejected` with `no endpoint named <name>`
- drop the `HttpClientError` cause from errors so a transport error cannot leak the endpoint URL
- document that events come in chain order (the provider's order) and that other HTTP statuses are not retried
