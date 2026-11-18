---
"@effect-blockchain/stellar": minor
---

Require `@stellar/stellar-sdk` 17

- Breaking: the `@stellar/stellar-sdk` peer dependency is `^17.0.0` instead of `^16.4.1`. Upgrade the SDK to 17 (tested with 17.0.0 and 17.4.0), which needs Node 22.12 or later. Version 16 is no longer supported: SDK 17 rebuilds the `xdr` namespace on `@stellar/js-xdr` 5, so the library decodes ledgers, transactions and results with its new API.
- The public API of the package is unchanged, and so are the values it decodes: base64 XDR strings in and out, `0x` hashes, result codes and balances.
