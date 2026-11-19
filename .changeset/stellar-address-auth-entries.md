---
"@effect-blockchain/stellar": minor
---

Sign address authorization entries in `@effect-blockchain/stellar` 0.6.0

- `StellarSigner` gains an optional `signAuthEntry({ network, hash })`, which signs the SHA-256 of a Soroban authorization entry's preimage (CAP-46-11) and returns the 64-byte ed25519 signature. `fromHashSigner` and `fromPrivateKey` provide it through `signHash` and the secret seed.
- `StellarRelayer.sign` signs the `sorobanCredentialsAddress` entries of the simulation whose address is the signer's or a cosigner's, in the format of the SDK's `authorizeEntry`, valid up to the transaction's `maxLedger`, then simulates the signed invocation again for its resources. It used to fail with `UnsupportedAuth`.
- A cosigner that only signs an authorization entry, and is the source of no operation, does not sign the transaction, which the network would refuse with `txBadAuthExtra`.
- `UnsupportedAuth` remains for a contract address, an account no signer with `signAuthEntry` covers, and other credentials.
