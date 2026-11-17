# `@effect-blockchain/evm`

EVM blockchain toolkit for Effect: RPC methods with endpoint fallback, an indexer, a relayer and signers.

## Installation

```bash
pnpm add @effect-blockchain/evm effect viem
```

`viem` is a required peer dependency: every module uses it, including `EvmRpc` and `EvmIndexer` through the address and hash schemas.

## Reading the chain

`EvmRpc` exposes the RPC methods over an ordered list of endpoints, and `EvmIndexer` reads confirmed blocks on top of it.

```ts
import * as EvmIndexer from "@effect-blockchain/evm/EvmIndexer"
import * as EvmRpc from "@effect-blockchain/evm/EvmRpc"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"

declare const filter: Omit<EvmIndexer.EvmIndexerFilter, "fromBlock" | "toBlock">
declare const cursor: bigint
declare const save: (block: bigint) => Effect.Effect<void>

const program = Effect.gen(function*() {
  const rpc = yield* EvmRpc.EvmRpc
  const indexer = yield* EvmIndexer.EvmIndexer
  yield* Effect.log(`head: ${yield* rpc.blockNumber}`)
  yield* indexer.streamLogs({ filter, fromBlock: cursor + BigInt(1) }).pipe(
    Stream.runForEach((batch) => save(batch.toBlock))
  )
})

const RpcLive = EvmRpc.layerConfig({
  network: Config.succeed("Ethereum"),
  endpoints: Config.all([Config.all({ name: Config.succeed("main"), url: Config.Redacted("ETHEREUM_RPC_URL") })])
})

const main = program.pipe(
  Effect.provide(EvmIndexer.layer().pipe(Layer.provideMerge(RpcLive), Layer.provide(FetchHttpClient.layer)))
)
```

## Sending a transaction

`EvmRelayer` signs a transaction, broadcasts it and follows it until it is final. `EvmSigner.fromPrivateKey({ key })` builds a signer from a `Redacted` private key, and `EvmSigner.fromHashSigner` adapts a custody API that signs a hash.

```ts
import type { EvmAddress } from "@effect-blockchain/evm/EvmAddress"
import * as EvmRelayer from "@effect-blockchain/evm/EvmRelayer"
import * as EvmRpc from "@effect-blockchain/evm/EvmRpc"
import type { EvmSigner } from "@effect-blockchain/evm/EvmSigner"
import type { EvmTransactionHash } from "@effect-blockchain/evm/EvmTransactionHash"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"

declare const signer: EvmSigner
declare const to: EvmAddress
declare const store: (hash: EvmTransactionHash, nonce: bigint) => Effect.Effect<void>

const program = Effect.gen(function*() {
  const relayer = yield* EvmRelayer.EvmRelayer
  const { hash, nonce, signed } = yield* relayer.sign({ signer, to, value: BigInt(1) })
  yield* store(hash, nonce)
  yield* relayer.broadcast({ signed })
  // `NotFound` keeps polling: the timeout bounds the wait
  return yield* relayer.awaitConfirmation({ hash }).pipe(Effect.timeout("10 minutes"))
})

const RpcLive = EvmRpc.layerConfig({
  network: Config.succeed("Ethereum"),
  endpoints: Config.all([Config.all({ name: Config.succeed("main"), url: Config.Redacted("ETHEREUM_RPC_URL") })])
})

const main = program.pipe(
  Effect.provide(EvmRelayer.layer().pipe(Layer.provide(RpcLive), Layer.provide(FetchHttpClient.layer)))
)
```

Endpoint fallback, the error reasons, the transaction statuses and confirmations are described in [Concepts](https://github.com/spiko-tech/effect-blockchain/blob/main/docs/concepts.md).

## License

MIT
