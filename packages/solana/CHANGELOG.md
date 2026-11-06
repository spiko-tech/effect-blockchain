# @effect-blockchain/solana

## 0.1.0

### Minor Changes

- [#58](https://github.com/spiko-tech/effect-blockchain/pull/58) [`b21f4e0`](https://github.com/spiko-tech/effect-blockchain/commit/b21f4e0c73c66efdcd796b98f21dd378357665b0) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - Initial release.
  
  - `SolanaRpc`: typed, read-only Solana JSON-RPC methods over an ordered list of endpoints with fallback.
  - `SolanaIndexer`: the last confirmed slot, the transactions touching an address over a slot range, and a stream of them following the confirmed head.
  - `SolanaNetwork`: named Solana clusters and their genesis hashes.
  - Schemas for `SolanaAddress` and `SolanaTransactionHash`, built on `@solana/kit`.

### Patch Changes

- Updated dependencies [[`b21f4e0`](https://github.com/spiko-tech/effect-blockchain/commit/b21f4e0c73c66efdcd796b98f21dd378357665b0)]:
  - @effect-blockchain/core@0.1.0
