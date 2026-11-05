---
"@effect-blockchain/evm": patch
---

Adds `EvmRpc.layerConfig` and `EvmIndexer.layerConfig`, building the layers from `Config`.

- `layerConfig(options: Config.Wrap<Options>)` takes the same options as `layer`, each one a `Config` (or one `Config` for the whole record), and fails with `Config.ConfigError` when a value is missing or invalid. Same requirements as `layer`.
- Endpoint URLs stay `Redacted`: read them with `Config.Redacted`, e.g. `Config.Redacted("ETHEREUM_RPC_URL")`. The library picks no env var names.
- `layer` is unchanged. Not breaking.
