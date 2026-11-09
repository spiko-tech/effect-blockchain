# @effect-blockchain/stellar

## 0.2.0

### Minor Changes

- [#68](https://github.com/spiko-tech/effect-blockchain/pull/68) [`8597f19`](https://github.com/spiko-tech/effect-blockchain/commit/8597f1979e24aee0420a3e9c470f33ecf7f197b6) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - Index the native (XLM) balance of an account.
  
  - `StellarIndexer.fetchNativeBalance({ address, block })`: the balance in stroops at the end of a ledger.
  - `StellarIndexer.streamNativeBalance({ address, fromBlock, toBlock?, step, poll?, retry? })`: a `StellarNativeBalance` sample every `step` ledgers, following the confirmed head.
  - `StellarRpc.getLedgers` (ledger metas, raw base64 XDR, falling back from `Pruned` to an archive endpoint) and `StellarRpc.getLedgerEntries` (raw base64 entries at the head, failing `Lagging` below `minLedger`).
  - History is read from the ledger metas of `getLedgers`, 1 to 3 MB per mainnet ledger: `step` does not reduce these reads.
  - An account missing at the head reads `0` at every ledger, even if it was merged later.
  - The `StellarRpc` service gains `getLedgers` and `getLedgerEntries`: a hand-written `StellarRpc` implementation (a test fake, for example) needs both.

## 0.1.0

### Minor Changes

- [#58](https://github.com/spiko-tech/effect-blockchain/pull/58) [`b21f4e0`](https://github.com/spiko-tech/effect-blockchain/commit/b21f4e0c73c66efdcd796b98f21dd378357665b0) Thanks [@nicolas-assouad-spiko](https://github.com/nicolas-assouad-spiko)! - Initial release.
  
  - `StellarRpc`: typed, read-only Stellar RPC methods over an ordered list of endpoints with fallback.
  - `StellarIndexer`: the last confirmed ledger, the Soroban contract events of a set of contracts over a ledger range, and a stream of them following the confirmed head.
  - `StellarNetwork`: named Stellar networks and their passphrases.
  - Schemas for `StellarAddress` (account and contract strkeys), `StellarContractEvent` and `StellarTransactionHash`, built on `@stellar/stellar-sdk`.

### Patch Changes

- Updated dependencies [[`b21f4e0`](https://github.com/spiko-tech/effect-blockchain/commit/b21f4e0c73c66efdcd796b98f21dd378357665b0)]:
  - @effect-blockchain/core@0.1.0
