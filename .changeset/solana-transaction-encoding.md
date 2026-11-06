---
"@effect-blockchain/solana": patch
---

`SolanaRpc.getTransaction`, `SolanaIndexer.fetchTransactions` and `SolanaIndexer.streamTransactions` take an `encoding` option, `"base64"` (default, unchanged) or `"json"`.

- `"json"` returns the transaction as a `SolanaJsonTransaction`: `signatures` and a `message` with `accountKeys`, `header`, `recentBlockhash`, compiled `instructions` (`programIdIndex`, `accounts`, base58 `data`) and `addressTableLookups` when present. Indexes are `number`s. `meta` is the same in both encodings.
- The result types follow the encoding: `SolanaTransactionInfo<Encoding>`, `SolanaIndexedTransaction<Encoding>` and `SolanaIndexerBatch<Encoding>`, each defaulting to `"base64"`. Calls without `encoding` keep their types.
- `fetchTransactions(filter, { encoding })` takes it as a second argument; `streamTransactions` takes it next to `filter`. New exports: `SolanaTransactionEncoding`, `SolanaJsonTransaction`, `SolanaCompiledInstruction`, `SolanaEncodedTransaction`, `SolanaTransactionQuery`, `SolanaStreamOptions`.
- Type-level only: the three methods are now overloaded, so `Parameters<...>` on them resolves to the `encoding`-required overload; use `SolanaTransactionQuery` / `SolanaStreamOptions` instead. A hand-written fake of `SolanaRpc` needs the same overloads for `getTransaction`.
