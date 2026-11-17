---
"@effect-blockchain/solana": patch
---

Shorten the module docs and document the shared semantics once

- Module headers are 1 to 3 sentences with one `@example`, and link to `docs/concepts.md` for the rules shared by the chains: endpoint fallback, error reasons, stream options, the stateless relayer, transaction statuses, confirmations and signers.
- `SolanaRpcError` and the Indexer stream options link to the shared description instead of repeating it.
- The README has an Rpc and Indexer example and a Relayer example, both type-checked.
- The `SolanaRelayer` header says that `sign` does not use durable nonces, while `fetchTransactionStatus` can follow a durable-nonce transaction signed elsewhere.
