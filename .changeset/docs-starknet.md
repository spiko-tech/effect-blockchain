---
"@effect-blockchain/starknet": patch
---

Shorten the module docs and document the shared semantics once

- Module headers are 1 to 3 sentences with one `@example`, and link to `docs/concepts.md` for the rules shared by the chains: endpoint fallback, error reasons, stream options, the stateless relayer, transaction statuses, confirmations and signers.
- `StarknetRpcError` and the Indexer stream options link to the shared description instead of repeating it.
- The README has an Rpc and Indexer example and a Relayer example, both type-checked.
- `StarknetRpcEndpoint` documents that a `getEvents` cursor goes to the first endpoint with the name of the one that issued it.
