---
"@effect-blockchain/evm": patch
"@effect-blockchain/starknet": patch
"@effect-blockchain/stellar": patch
"@effect-blockchain/solana": patch
---

Align the `<Chain>Network` modules on the `EvmNetwork` convention: `networks`, `mainnets`, `testnets`, `isTestnet` and one function from a network to the identity its RPC reports.

- starknet: `starknetNetworks` and `StarknetNetworkInfo` are replaced by `networks`, `mainnets`, `testnets`, `isTestnet`, `toChainId` and the new `StarknetChainId` schema. `StarknetRpc.chainId` now returns `StarknetChainId`.
- stellar: `STELLAR_NETWORKS`, `STELLAR_MAINNET_NETWORKS` and `STELLAR_TESTNET_NETWORKS` become `networks`, `mainnets` and `testnets`. `STELLAR_NETWORK_PASSPHRASES` becomes `toPassphrase`. `isTestnet` is new.
- solana: `SolanaNetworkKind` and `SOLANA_NETWORK_KINDS` are replaced by `networks`, `mainnets`, `testnets` and `isTestnet`. `isSolanaNetwork` is removed (use `Schema.is(SolanaNetwork)`). The genesis hashes move from `SolanaRpc` to `toGenesisHash`. Doc categories are lowercased.
- evm: no API change, the reference convention.
