---
"@effect-blockchain/starknet": minor
---

Initial release.

- `StarknetRpc`: typed, read-only Starknet JSON-RPC methods over an ordered list of endpoints with fallback.
- `StarknetIndexer`: the last confirmed block, the events of a contract over a block range, and a stream of them following the confirmed head.
- `StarknetNetwork`: named Starknet networks and their chain IDs.
- Schemas for `StarknetAddress`, `StarknetBlock`, `StarknetEvent` and `StarknetTransactionHash`, built on starknet.js.
