---
"@effect-blockchain/core": minor
---

Share the confirmation rules of the chain packages, and parse each reply once.

- New `Confirmations` module: `lastConfirmedBlock(head, confirmations)`, `DEFAULT_POLL_INTERVAL` (10 seconds) and `awaitConfirmation({ fetch, isFinal, poll? })`, which reads a status on `poll` until it is final. A read failing with a transient reason (`JsonRpc.isTransient`) is read again on `poll`, any other error fails the wait.
- `JsonRpc.method` types a method literal, and `JsonRpc.errorsOf` lists the errors under a fallback error, both for the chain packages.
- The engine parses a reply body once, inside the retried and timed attempt, instead of twice.
