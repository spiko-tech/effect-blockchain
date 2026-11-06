---
"@effect-blockchain/evm": minor
---

Add the Anvil local network (chain ID 31337).

`EvmNetwork` gains the `"Anvil"` literal, so an exhaustive `Record<EvmNetwork, ...>` in caller code needs an `Anvil` entry.
