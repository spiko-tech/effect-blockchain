---
"@effect-blockchain/stellar": patch
---

Shorten the module docs and document the shared semantics once

- Module headers are 1 to 3 sentences with one `@example`, and link to `docs/concepts.md` for the rules shared by the chains: endpoint fallback, error reasons, stream options, the stateless relayer, transaction statuses, confirmations and signers.
- `StellarRpcError` and the Indexer stream options link to the shared description instead of repeating it.
- The README has an Rpc and Indexer example and a Relayer example, both type-checked.
- `StellarRelayer.sign` documents `UnsupportedAuth` and the authorization entries passed by the caller, which are kept.
- `StellarRpc` documents what a node answers to a second copy of a transaction: `DUPLICATE`, then `TRY_AGAIN_LATER`, then `txBadSeq`.
- `StellarRpcEndpoint` no longer says that endpoint names must be unique: a cursor goes to the first endpoint with the name of the one that issued it.
- The channel account and fee bump sample moved from the module header to the `@example` of `feeBump`.
