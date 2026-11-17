# `@effect-blockchain/stellar`

Stellar blockchain toolkit for Effect: RPC methods with endpoint fallback, an indexer, a relayer and signers.

## Installation

```bash
pnpm add @effect-blockchain/stellar effect @stellar/stellar-sdk
```

`@stellar/stellar-sdk` is a required peer dependency: every module uses it, including `StellarRpc` and `StellarIndexer`.

## Reading the chain

`StellarRpc` exposes the RPC methods over an ordered list of endpoints, and `StellarIndexer` reads confirmed blocks on top of it.

```ts
import * as StellarIndexer from "@effect-blockchain/stellar/StellarIndexer"
import * as StellarRpc from "@effect-blockchain/stellar/StellarRpc"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"

declare const filter: Omit<StellarIndexer.StellarIndexerFilter, "fromBlock" | "toBlock">
declare const cursor: bigint
declare const save: (ledger: bigint) => Effect.Effect<void>

const program = Effect.gen(function*() {
  const rpc = yield* StellarRpc.StellarRpc
  const indexer = yield* StellarIndexer.StellarIndexer
  yield* Effect.log(`head: ${(yield* rpc.getLatestLedger).sequence}`)
  yield* indexer.streamEvents({ filter, fromBlock: cursor + BigInt(1) }).pipe(
    Stream.runForEach((batch) => save(batch.toBlock))
  )
})

const RpcLive = StellarRpc.layerConfig({
  network: Config.succeed("Stellar"),
  endpoints: Config.all([Config.all({ name: Config.succeed("main"), url: Config.Redacted("STELLAR_RPC_URL") })])
})

const main = program.pipe(
  Effect.provide(StellarIndexer.layer().pipe(Layer.provideMerge(RpcLive), Layer.provide(FetchHttpClient.layer)))
)
```

## Sending a transaction

`StellarRelayer` signs a transaction, broadcasts it and follows it until it is final. `StellarSigner.fromPrivateKey({ key })` builds a signer from a `Redacted` secret seed, and `StellarSigner.fromHashSigner` adapts a custody API that signs a hash.

```ts
import type { StellarAccountAddress } from "@effect-blockchain/stellar/StellarAddress"
import * as StellarRelayer from "@effect-blockchain/stellar/StellarRelayer"
import * as StellarRpc from "@effect-blockchain/stellar/StellarRpc"
import type { StellarSigner } from "@effect-blockchain/stellar/StellarSigner"
import type { StellarTransactionHash } from "@effect-blockchain/stellar/StellarTransactionHash"
import { Asset, Operation } from "@stellar/stellar-sdk"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"

declare const signer: StellarSigner
declare const destination: StellarAccountAddress
declare const store: (hash: StellarTransactionHash, sequence: bigint, maxLedger: bigint) => Effect.Effect<void>

const program = Effect.gen(function*() {
  const relayer = yield* StellarRelayer.StellarRelayer
  const payment = Operation.payment({ destination, asset: Asset.native(), amount: "1" }).toXDR("base64")
  const { hash, maxLedger, sequence, signed } = yield* relayer.sign({ signer, operations: [payment] })
  yield* store(hash, sequence, maxLedger)
  yield* relayer.broadcast({ signed })
  // `maxLedger` ends the wait with `Expired` when no ledger took the transaction, the timeout bounds the rest
  return yield* relayer.awaitConfirmation({ hash, maxLedger }).pipe(Effect.timeout("10 minutes"))
})

const RpcLive = StellarRpc.layerConfig({
  network: Config.succeed("Stellar"),
  endpoints: Config.all([Config.all({ name: Config.succeed("main"), url: Config.Redacted("STELLAR_RPC_URL") })])
})

const main = program.pipe(
  Effect.provide(StellarRelayer.layer().pipe(Layer.provide(RpcLive), Layer.provide(FetchHttpClient.layer)))
)
```

Endpoint fallback, the error reasons, the transaction statuses and confirmations are described in [Concepts](https://github.com/spiko-tech/effect-blockchain/blob/main/docs/concepts.md).

## License

MIT
