---
"@effect-blockchain/stellar": minor
---

Sign Soroban invocations and fee bumps on Stellar.

- `StellarRelayer.sign` simulates a transaction of one `invokeHostFunction` operation and gives it its footprint, its resource fee and its authorization entries. Its fee per operation comes from the Soroban inclusion fees of `getFeeStats`. A failed simulation, or an entry another address must sign, fails with a `StellarSimulationError` whose `reason` is `SimulationFailed` or `UnsupportedAuth`.
- `StellarRelayer.feeBump({ signer, signed, fee? })` wraps a signed transaction in a fee bump paid by `signer` and returns `{ hash, signed }`, with the hash of the fee bump. A missing fee comes from the fee strategy, and is at least the fee of the inner transaction.
- `StellarRpc` gains `simulateTransaction`.
- `StellarRpc.sendTransaction` fails `InvalidResponse` when the node answers for another hash than the envelope's, and `Rejected` without a request when the envelope is not XDR.

The `StellarRpc` service gains `simulateTransaction` and the `StellarRelayer` service `feeBump`: a hand-written fake (`StellarRpc.of(...)`, `StellarRelayer.of(...)`) needs the new entries. `StellarRelayer.sign` can now fail with a `StellarSimulationError`.
