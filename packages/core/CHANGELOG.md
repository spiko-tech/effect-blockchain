# @effect-blockchain/core

## 0.1.0

### Minor Changes

- [#58](https://github.com/spiko-tech/effect-blockchain/pull/58) [`b21f4e0`](https://github.com/spiko-tech/effect-blockchain/commit/b21f4e0c73c66efdcd796b98f21dd378357665b0) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - Initial release.
  
  - `JsonRpc`: the shared JSON-RPC engine behind the chain packages, with ordered endpoints and fallback.
  - Typed error reasons shared by every chain: `Unavailable`, `InvalidResponse`, `Lagging`, `Pruned`, `Rejected`, `WrongNetwork`.
  - `isTransient` to retry only the failures a later attempt can fix.
  - RPC metrics for every call.
