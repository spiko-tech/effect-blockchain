---
"@effect-blockchain/solana": minor
---

Sign and broadcast Solana transactions.

- `SolanaRelayer.sign({ feePayer, signers?, instructions, blockhash?, computeUnitLimit?, computeUnitPrice? })` signs a v0 transaction and returns `{ hash, signed, lastValidBlockHeight }` before anything is sent: `hash` is the fee payer's signature and `lastValidBlockHeight` is what `fetchTransactionStatus` and `awaitConfirmation` take. A missing blockhash is the latest one at `confirmed`, a missing compute unit limit is what `simulateTransaction` consumed times `computeUnitMultiplier` (1.2 by default), a missing compute unit price comes from the fee strategy. Both are prepended as Compute Budget instructions. A transaction whose simulation fails fails with `SimulationFailed`.
- `SolanaRelayer.broadcast({ signed })` sends it with a preflight at `confirmed` and returns its hash. A node that has already processed the transaction is a success. A preflight failure fails with a `SolanaBroadcastError` whose `reason` is `BlockhashNotFound`, `InsufficientFundsForFee` or `SimulationFailed`, which carries the transaction error and the logs.
- `SolanaRelayer.layer` takes `fees`, a strategy from the `getRecentPrioritizationFees` entries of the accounts the transaction writes to, to a compute unit price in micro-lamports, and `computeUnitMultiplier`. `SolanaRelayer.defaultFees` is the default: the 75th percentile, at least 1 micro-lamport.
- `SolanaInstruction` and `SolanaAccountMeta` describe the instructions to sign.
- `SolanaRpc.layer` takes `genesisHash`, which replaces the genesis hash of `network` for a local validator or a private cluster.

The `SolanaRelayer` service gains `sign` and `broadcast`, so a hand-written fake (`SolanaRelayer.of(...)`) needs the two new entries.
