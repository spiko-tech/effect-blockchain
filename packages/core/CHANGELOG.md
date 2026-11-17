# @effect-blockchain/core

## 0.2.0

### Minor Changes

- [#85](https://github.com/spiko-tech/effect-blockchain/pull/85) [`5d75cb8`](https://github.com/spiko-tech/effect-blockchain/commit/5d75cb8761d7ed6b8443e74434ee4f9e123a0633) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - Share the confirmation rules of the chain packages, and parse each reply once.
  
  - New `Confirmations` module: `lastConfirmedBlock(head, confirmations)`, `DEFAULT_POLL_INTERVAL` (10 seconds) and `awaitConfirmation({ fetch, isFinal, poll? })`, which reads a status on `poll` until it is final. A read failing with a transient reason (`JsonRpc.isTransient`) is read again on `poll`, any other error fails the wait.
  - `JsonRpc.method` types a method literal, and `JsonRpc.errorsOf` lists the errors under a fallback error, both for the chain packages.
  - The engine parses a reply body once, inside the retried and timed attempt, instead of twice.

- [#90](https://github.com/spiko-tech/effect-blockchain/pull/90) [`2c0d672`](https://github.com/spiko-tech/effect-blockchain/commit/2c0d672c3288722af9019ec503bf9519b1df51cd) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - The `JsonRpc` engine can restrict a call to some of its endpoints.
  
  - The engine exposes its `endpoints`, and `withFallback(f, only)` takes an optional non-empty subset of them, tried in the order given. Both are for the chain packages.

### Patch Changes

- [#91](https://github.com/spiko-tech/effect-blockchain/pull/91) [`90ca1fa`](https://github.com/spiko-tech/effect-blockchain/commit/90ca1fa28406bffe7b4d2abc921608f44de8f897) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - Use the type-checked `JsonRpc` example in the README
  
  - The README sample is the `@example` of the `JsonRpc` module, which the docs build compiles.

## 0.1.0

### Minor Changes

- [#58](https://github.com/spiko-tech/effect-blockchain/pull/58) [`b21f4e0`](https://github.com/spiko-tech/effect-blockchain/commit/b21f4e0c73c66efdcd796b98f21dd378357665b0) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - Initial release.
  
  - `JsonRpc`: the shared JSON-RPC engine behind the chain packages, with ordered endpoints and fallback.
  - Typed error reasons shared by every chain: `Unavailable`, `InvalidResponse`, `Lagging`, `Pruned`, `Rejected`, `WrongNetwork`.
  - `isTransient` to retry only the failures a later attempt can fix.
  - RPC metrics for every call.
