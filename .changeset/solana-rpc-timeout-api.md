---
"@effect-blockchain/solana": patch
---

`SolanaRpc` falls back at once on a timeout, and `getGenesisHash` returns a branded `SolanaGenesisHash`.

- A timed-out attempt is no longer retried on the same endpoint: it fails `Unavailable` and the call moves to the next endpoint at once. Transport errors, HTTP 408/429/500/502/503/504 and the `Unavailable` JSON-RPC codes are still retried. The default timeout stays 30 seconds.
- New `SolanaGenesisHash` schema and type in `SolanaNetwork` (a base58-encoded 32-byte hash, validated with `@solana/kit`). `toGenesisHash` and `SolanaRpc.getGenesisHash` return it instead of `string`.
