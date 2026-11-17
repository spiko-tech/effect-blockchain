# `@effect-blockchain/solana`

Solana blockchain toolkit for Effect: RPC methods with endpoint fallback, an indexer, a relayer and signers.

## Installation

```bash
pnpm add @effect-blockchain/solana effect @solana/kit
```

`@solana/kit` is a required peer dependency: every module uses it, including `SolanaRpc` and `SolanaIndexer`.

## Reading the chain

`SolanaRpc` exposes the RPC methods over an ordered list of endpoints, and `SolanaIndexer` reads confirmed blocks on top of it.

```ts
import * as SolanaIndexer from "@effect-blockchain/solana/SolanaIndexer"
import * as SolanaRpc from "@effect-blockchain/solana/SolanaRpc"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"

declare const filter: Omit<SolanaIndexer.SolanaIndexerFilter, "fromBlock" | "toBlock">
declare const cursor: bigint
declare const save: (slot: bigint) => Effect.Effect<void>

const program = Effect.gen(function*() {
  const rpc = yield* SolanaRpc.SolanaRpc
  const indexer = yield* SolanaIndexer.SolanaIndexer
  yield* Effect.log(`head: ${yield* rpc.getSlot({ commitment: "finalized" })}`)
  yield* indexer.streamTransactions({ filter, fromBlock: cursor + BigInt(1) }).pipe(
    Stream.runForEach((batch) => save(batch.toBlock))
  )
})

const RpcLive = SolanaRpc.layerConfig({
  network: Config.succeed("Solana"),
  endpoints: Config.all([Config.all({ name: Config.succeed("main"), url: Config.Redacted("SOLANA_RPC_URL") })])
})

const main = program.pipe(
  Effect.provide(SolanaIndexer.layer().pipe(Layer.provideMerge(RpcLive), Layer.provide(FetchHttpClient.layer)))
)
```

## Sending a transaction

`SolanaRelayer` signs a transaction, broadcasts it and follows it until it is final. `SolanaSigner.fromPrivateKey({ key })` builds a signer from a `Redacted` base58 secret key, and `SolanaSigner.fromMessageSigner` adapts a custody API that signs the message bytes.

```ts
import * as SolanaRelayer from "@effect-blockchain/solana/SolanaRelayer"
import * as SolanaRpc from "@effect-blockchain/solana/SolanaRpc"
import type { SolanaSigner } from "@effect-blockchain/solana/SolanaSigner"
import type { SolanaTransactionHash } from "@effect-blockchain/solana/SolanaTransactionHash"
import type * as Arr from "effect/Array"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"

declare const signer: SolanaSigner
declare const instructions: Arr.NonEmptyReadonlyArray<SolanaRelayer.SolanaInstruction>
declare const store: (hash: SolanaTransactionHash, lastValidBlockHeight: bigint) => Effect.Effect<void>

const program = Effect.gen(function*() {
  const relayer = yield* SolanaRelayer.SolanaRelayer
  const { hash, lastValidBlockHeight, signed } = yield* relayer.sign({ signer, instructions })
  yield* store(hash, lastValidBlockHeight)
  yield* relayer.broadcast({ signed })
  // `Expired` ends the wait when the transaction can no longer land, the timeout bounds the rest
  return yield* relayer.awaitConfirmation({ hash, lastValidBlockHeight }).pipe(Effect.timeout("5 minutes"))
})

const RpcLive = SolanaRpc.layerConfig({
  network: Config.succeed("Solana"),
  endpoints: Config.all([Config.all({ name: Config.succeed("main"), url: Config.Redacted("SOLANA_RPC_URL") })])
})

const main = program.pipe(
  Effect.provide(SolanaRelayer.layer().pipe(Layer.provide(RpcLive), Layer.provide(FetchHttpClient.layer)))
)
```

Endpoint fallback, the error reasons, the transaction statuses and confirmations are described in [Concepts](https://github.com/spiko-tech/effect-blockchain/blob/main/docs/concepts.md).

## License

MIT
