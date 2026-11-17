---
"@effect-blockchain/starknet": minor
---

Sign and broadcast Starknet transactions, and deploy an account.

- `StarknetRelayer.sign({ signer, calls, nonce?, resourceBounds?, tip? })` signs an `INVOKE` V3 running `calls` (`{ contractAddress, entrypoint, calldata }`) through the `__execute__` entrypoint of a Cairo 1 account, and returns `{ hash, signed, nonce }` before anything is sent. A missing nonce is the account's nonce at the pre-confirmed block, missing resource bounds come from the fee strategy over `starknet_estimateFee`, a missing tip is 0.
- `StarknetRelayer.signDeployAccount({ signer, classHash, salt, constructorCalldata, resourceBounds?, tip? })` signs the `DEPLOY_ACCOUNT` V3 of the signer's own account. The address these deploy to is computed and must be `signer.address`.
- `StarknetRelayer.broadcast({ signed })` sends either transaction and returns its hash. A node that already has the transaction (`DUPLICATE_TX`, or an invalid nonce while it knows the hash) is a success. `INVALID_TRANSACTION_NONCE`, `INSUFFICIENT_ACCOUNT_BALANCE`, `INSUFFICIENT_RESOURCES_FOR_VALIDATE`, `FEE_BELOW_MINIMUM`, `VALIDATION_FAILURE` and `REPLACEMENT_TRANSACTION_UNDERPRICED` fail with a `StarknetBroadcastError` whose `reason` is `InvalidNonce`, `InsufficientBalance`, `InsufficientResources`, `ValidationFailure` or `ReplacementUnderpriced`.
- `StarknetRelayer.layer` takes `fees`, a strategy from a `StarknetFeeEstimate` to `StarknetResourceBounds`. `StarknetRelayer.defaultFees` is the default: 1.5 times each estimated amount at 1.5 times its estimated price, after 300,000 L2 gas for the account's validation, which the unsigned estimate leaves out.
- `StarknetRpc.estimateFee` takes and returns non-empty arrays: a reply without an estimate is an `InvalidResponse`.
- `StarknetRpc.getTransactionStatus` accepts the `"failure_reason": null` that starknet-devnet answers.

The `StarknetRelayer` service gains `sign`, `signDeployAccount` and `broadcast`, so a hand-written fake (`StarknetRelayer.of(...)`) needs the three new entries.
