---
"@effect-blockchain/stellar": minor
---

Sign and broadcast Stellar transactions.

- `StellarSigner`: a signer is `{ address, signTransaction }` and signs a whole transaction or fee bump envelope. `fromPrivateKey(seed)` holds an `S...` secret seed, `fromHashSigner({ address, signHash })` wraps a custody API that only signs the transaction hash. Failures are a `StellarSignerError`.
- `StellarRelayer.sign({ signer, operations, sequence?, fee?, maxLedger? })` signs a transaction of classic operations (base64 `Operation` XDR) and returns `{ hash, signed, sequence, maxLedger }` before anything is sent. A missing sequence is the account's sequence number plus 1, a missing fee per operation comes from the fee strategy, a missing `maxLedger` is the latest ledger plus `validity`.
- `StellarRelayer.broadcast({ signed })` sends the envelope and returns its hash. A node that already holds the transaction, or has it in a ledger, is a success. `TRY_AGAIN_LATER` and a refusal fail with a `StellarBroadcastError` whose `reason` is `TryAgainLater` or `Refused`, with the result code (`txBadSeq`, `txInsufficientFee`...).
- `StellarRelayer.layer` takes `fees`, a strategy from the classic inclusion fees of `getFeeStats` to a fee per operation, and `validity` (60 ledgers by default). `StellarRelayer.defaultFees` is the default: the 90th percentile, at least 100 stroops.
- `StellarRpc` gains `getFeeStats` and `sendTransaction`.
- `StellarNetwork` gains `StellarStandalone`, the local network of `stellar/quickstart --local`.

The `StellarRpc` service gains `getFeeStats` and `sendTransaction`, and the `StellarRelayer` service `sign` and `broadcast`: a hand-written fake (`StellarRpc.of(...)`, `StellarRelayer.of(...)`) needs the new entries. Code matching every `StellarNetwork` needs a `StellarStandalone` case.
