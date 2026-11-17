---
"@effect-blockchain/solana": patch
---

`SolanaTransactionMeta` restores the status meta fields removed in 0.2.0: `getTransaction`, `fetchTransactions` and `streamTransactions` return every field the node sends again.

- Every field the library does not type (`logMessages`, `computeUnitsConsumed`, `rewards`, `returnData`...) is kept as raw JSON, integers as decimal strings, as in 0.1.0. A field a node adds later is kept the same way.
- New typed fields: `innerInstructions` (`SolanaInnerInstruction`, with `stackHeight`), `preTokenBalances` and `postTokenBalances` (`SolanaTokenBalance`, with `uiTokenAmount.amount` as an exact `bigint` and `decimals`). Each is absent or `null` when the node did not record it.
- `SolanaRpcJson` is the type of the untyped fields: JSON in which an integer may be a `bigint`.
