# `@effect-blockchain/starknet`

Starknet blockchain toolkit for Effect: RPC methods with endpoint fallback, an indexer, a relayer and signers.

## Installation

```bash
pnpm add @effect-blockchain/starknet effect starknet
```

`starknet` is an optional peer dependency: only `StarknetRelayer` and `StarknetSigner` need it. Without it, install `@effect-blockchain/starknet effect` and import the other modules by subpath (`@effect-blockchain/starknet/StarknetRpc`, `@effect-blockchain/starknet/StarknetIndexer`), since the package root re-exports the Relayer and the Signer.

## Reading the chain

`StarknetRpc` exposes the RPC methods over an ordered list of endpoints, and `StarknetIndexer` reads confirmed blocks on top of it.

```ts
import * as StarknetIndexer from "@effect-blockchain/starknet/StarknetIndexer"
import * as StarknetRpc from "@effect-blockchain/starknet/StarknetRpc"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"

declare const filter: Omit<StarknetIndexer.StarknetIndexerFilter, "fromBlock" | "toBlock">
declare const cursor: bigint
declare const save: (block: bigint) => Effect.Effect<void>

const program = Effect.gen(function*() {
  const rpc = yield* StarknetRpc.StarknetRpc
  const indexer = yield* StarknetIndexer.StarknetIndexer
  yield* Effect.log(`head: ${yield* rpc.blockNumber}`)
  yield* indexer.streamEvents({ filter, fromBlock: cursor + BigInt(1) }).pipe(
    Stream.runForEach((batch) => save(batch.toBlock))
  )
})

const RpcLive = StarknetRpc.layerConfig({
  network: Config.succeed("Starknet"),
  endpoints: Config.all([Config.all({ name: Config.succeed("main"), url: Config.Redacted("STARKNET_RPC_URL") })])
})

const main = program.pipe(
  Effect.provide(StarknetIndexer.layer().pipe(Layer.provideMerge(RpcLive), Layer.provide(FetchHttpClient.layer)))
)
```

## Sending a transaction

`StarknetRelayer` signs a transaction, broadcasts it and follows it until it is final. `StarknetSigner.fromPrivateKey({ key, address })` builds a signer from a `Redacted` private key and the address of its account contract, and `StarknetSigner.fromHashSigner` adapts a custody API that signs a hash.

```ts
import type { StarknetAddress } from "@effect-blockchain/starknet/StarknetAddress"
import * as StarknetRelayer from "@effect-blockchain/starknet/StarknetRelayer"
import * as StarknetRpc from "@effect-blockchain/starknet/StarknetRpc"
import type { StarknetSigner } from "@effect-blockchain/starknet/StarknetSigner"
import type { StarknetTransactionHash } from "@effect-blockchain/starknet/StarknetTransactionHash"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"

declare const signer: StarknetSigner
declare const token: StarknetAddress
declare const to: StarknetAddress
declare const store: (hash: StarknetTransactionHash, nonce: bigint) => Effect.Effect<void>

const program = Effect.gen(function*() {
  const relayer = yield* StarknetRelayer.StarknetRelayer
  // an ERC-20 `transfer(recipient, amount)`, the amount being a u256 as two felts
  const calls = [{ contractAddress: token, entrypoint: "transfer", calldata: [to, "0x1", "0x0"] }] as const
  const { hash, nonce, signed } = yield* relayer.sign({ signer, calls })
  yield* store(hash, nonce)
  yield* relayer.broadcast({ signed })
  // `NotFound` keeps polling: the timeout bounds the wait
  return yield* relayer.awaitConfirmation({ hash }).pipe(Effect.timeout("10 minutes"))
})

const RpcLive = StarknetRpc.layerConfig({
  network: Config.succeed("Starknet"),
  endpoints: Config.all([Config.all({ name: Config.succeed("main"), url: Config.Redacted("STARKNET_RPC_URL") })])
})

const main = program.pipe(
  Effect.provide(StarknetRelayer.layer().pipe(Layer.provide(RpcLive), Layer.provide(FetchHttpClient.layer)))
)
```

Endpoint fallback, the error reasons, the transaction statuses and confirmations are described in [Concepts](https://github.com/spiko-tech/effect-blockchain/blob/main/docs/concepts.md).

## License

MIT
