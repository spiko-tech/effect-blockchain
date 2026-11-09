# @effect-blockchain/solana

## 0.2.0

### Minor Changes

- [#67](https://github.com/spiko-tech/effect-blockchain/pull/67) [`7fddf4a`](https://github.com/spiko-tech/effect-blockchain/commit/7fddf4a644175d7965018e1f35c8ccd96be156f7) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - Read the native (lamport) balance of an address.
  
  - `SolanaIndexer.fetchNativeBalance({ address, block })`: the lamports at the end of a slot, from the meta of the address's newest transaction at or before it, or `getBalance` at the confirmed head.
  - `SolanaIndexer.streamNativeBalance({ address, fromBlock, toBlock, step, poll, retry })`: a `SolanaNativeBalance` sample every `step` slots, following the confirmed head.
  - `SolanaRpc.getBalance({ address })` at `finalized` commitment.
  - **Breaking:** `SolanaTransactionInfo.meta` is now a typed `SolanaTransactionMeta | null` (`err`, `fee`, `preBalances`, `postBalances` as `bigint`, `loadedAddresses`) instead of raw JSON with decimal strings; its other fields (logs, token balances, inner instructions...) are dropped. The `SolanaRpc` service gains a required `getBalance` member, so a hand-written implementation needs one.

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
