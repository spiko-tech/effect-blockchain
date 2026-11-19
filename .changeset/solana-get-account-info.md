---
"@effect-blockchain/solana": minor
---

Add `SolanaRpc.getAccountInfo`

- `getAccountInfo({ address, commitment, encoding, minContextSlot })` returns the account at the context `slot`, `null` for an address that holds none. A `minContextSlot` the endpoint has not reached fails `Lagging` and falls back to the next endpoint.
- New models `SolanaAccountEncoding` (`"base64" | "jsonParsed"`), `SolanaAccountData`, `SolanaAccount` and `SolanaAccountInfo`: the account types `owner`, `lamports`, `executable` and `data` by encoding, and keeps every other field as raw JSON.
