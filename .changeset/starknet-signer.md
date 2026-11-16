---
"@effect-blockchain/starknet": minor
---

Sign Starknet transactions, and the RPC methods sending them needs.

- `StarknetSigner`: a signer value for V3 `INVOKE` and `DEPLOY_ACCOUNT` transactions, built with `fromPrivateKey({ address, key })` (a local Stark curve key) or `fromHashSigner({ address, signHash })` (a custody API that signs a hash). It returns the signature felts of the account contract, `[r, s]` for OpenZeppelin and Argent accounts. Failures are a `StarknetSignerError`.
- `StarknetTransaction`: the `StarknetInvokeTransaction`, `StarknetDeployAccountTransaction` and `StarknetResourceBounds` models.
- `StarknetRpc` gains `getNonce`, `estimateFee` (with `skipValidate` for unsigned transactions), `addInvokeTransaction` and `addDeployAccountTransaction`, with the `StarknetBlockTag` and `StarknetFeeEstimate` models.

The `StarknetRpc` service gains members, so a hand-written fake (`StarknetRpc.of(...)`) needs the four new entries.
