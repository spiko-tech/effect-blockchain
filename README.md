# `effect-blockchain`

Effect toolkit for EVM, Starknet, Stellar and Solana.

| Package                                              | Description                                     |
| ---------------------------------------------------- | ----------------------------------------------- |
| [`@effect-blockchain/evm`](./packages/evm)           | EVM networks (Ethereum, Polygon, Base, …), viem |
| [`@effect-blockchain/starknet`](./packages/starknet) | Starknet, starknet.js                           |
| [`@effect-blockchain/stellar`](./packages/stellar)   | Stellar, `@stellar/stellar-sdk`                 |
| [`@effect-blockchain/solana`](./packages/solana)     | Solana, `@solana/kit`                           |

## Installation

```bash
pnpm add @effect-blockchain/evm effect viem
pnpm add @effect-blockchain/starknet effect starknet
pnpm add @effect-blockchain/stellar effect @stellar/stellar-sdk
pnpm add @effect-blockchain/solana effect @solana/kit
```

`@effect-blockchain/core` comes with each chain package. `viem`, `@stellar/stellar-sdk` and `@solana/kit` are required by every module of their package. `starknet` is only needed by `StarknetRelayer` and `StarknetSigner`: without it, import the other Starknet modules by subpath, as the package root re-exports these two.

## Reading a chain

Each chain has a `<Chain>Rpc` (the RPC methods over an ordered list of endpoints with fallback) and a `<Chain>Indexer` on top of it. On EVM:

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

Each chain has a `<Chain>Relayer` that signs a transaction, broadcasts it and follows it until it is final, with a `<Chain>Signer` holding a key in memory or adapting a custody API.

### EVM

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

### Starknet

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

### Solana

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

### Stellar

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

Endpoint fallback, the error reasons, the transaction statuses and confirmations are described in [Concepts](./docs/concepts.md).

## License

MIT
