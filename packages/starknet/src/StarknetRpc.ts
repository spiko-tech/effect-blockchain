/**
 * Typed, read-only Starknet JSON-RPC methods over an ordered list of endpoints with fallback.
 *
 * A call starts at the first endpoint and moves to the next one on failure, except on `WrongNetwork`. Each endpoint
 * is checked once to serve the configured network (`starknet_chainId`). Every method is a read, so retries and
 * fallback are safe. Methods are named after the JSON-RPC method without its namespace (`starknet_getEvents` is
 * `getEvents`). A `getEvents` page cursor is only sent to the endpoint that issued it, with no fallback.
 *
 * @example
 * ```ts
 * import type { StarknetAddress } from "@effect-blockchain/starknet/StarknetAddress"
 * import type { StarknetEvent } from "@effect-blockchain/starknet/StarknetEvent"
 * import * as StarknetRpc from "@effect-blockchain/starknet/StarknetRpc"
 * import * as Effect from "effect/Effect"
 *
 * declare const address: StarknetAddress
 *
 * // every event of `address` in blocks 100 to 200, page by page
 * const events = Effect.gen(function*() {
 *   const rpc = yield* StarknetRpc.StarknetRpc
 *   const all: Array<StarknetEvent> = []
 *   let cursor: StarknetRpc.StarknetEventsCursor | undefined
 *   do {
 *     const page = yield* rpc.getEvents({ address, fromBlock: BigInt(100), toBlock: BigInt(200), cursor })
 *     all.push(...page.events)
 *     cursor = page.cursor
 *   } while (cursor !== undefined)
 *   return all
 * })
 * ```
 *
 * @since 0.1.0
 */
import * as JsonRpc from "@effect-blockchain/core/JsonRpc"
import type * as Arr from "effect/Array"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import type * as HttpClient from "effect/http/HttpClient"
import * as Layer from "effect/Layer"
import type * as Redacted from "effect/Redacted"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as RpcMethods from "./internal/rpcMethods.ts"
import type { StarknetAddress } from "./StarknetAddress.ts"
import type { StarknetBlock } from "./StarknetBlock.ts"
import type { StarknetEvent } from "./StarknetEvent.ts"
import * as StarknetNetwork from "./StarknetNetwork.ts"
import type { StarknetTransactionHash } from "./StarknetTransactionHash.ts"

/**
 * A JSON-RPC endpoint. The `name` is shown in errors and spans, the `url` is never logged.
 *
 * @since 0.1.0
 * @category models
 */
export interface StarknetRpcEndpoint {
  readonly name: string
  readonly url: Redacted.Redacted<string>
}

/**
 * A failed call: its `reason` (a {@link JsonRpc.Reason}, matched with `Effect.catchReason`), the JSON-RPC error code or
 * HTTP status as `code`, and a `cause` without the endpoint URL. After several endpoints, the error is the last one
 * and `cause` is an `AggregateError` of each endpoint's error, in order.
 *
 * On Starknet, `Unavailable` includes the codes 63 (`UNEXPECTED_ERROR`), -32603, -32005 and 429, `InvalidResponse` an
 * event outside the `getEvents` filter, and `Lagging` a head below the requested block, `BLOCK_NOT_FOUND` (24) and
 * `TXN_HASH_NOT_FOUND` (29).
 *
 * @since 0.1.0
 * @category errors
 */
export class StarknetRpcError extends Schema.TaggedError<StarknetRpcError>()("StarknetRpcError", {
  reason: JsonRpc.Reason,
  method: Schema.String,
  endpoint: Schema.String,
  code: Schema.optional(Schema.Number),
  cause: Schema.Defect()
}) {
  /**
   * @since 0.1.0
   */
  override get message(): string {
    return `${this.method} failed on ${this.endpoint}: ${this.reason._tag}${
      this.code === undefined ? "" : ` (${this.code})`
    }`
  }
}

/**
 * Where to continue a `starknet_getEvents` range: the provider's continuation token and the endpoint that issued it.
 * Opaque: only pass it back to {@link StarknetRpc} `getEvents` with the same filter.
 *
 * @since 0.1.0
 * @category schemas
 */
export const StarknetEventsCursor = Schema.Struct({
  endpoint: Schema.String,
  cursor: Schema.String
}).pipe(Schema.brand("StarknetEventsCursor"))

/**
 * @since 0.1.0
 * @category models
 */
export type StarknetEventsCursor = typeof StarknetEventsCursor.Type

/**
 * A `starknet_getEvents` filter over the inclusive block range `[fromBlock, toBlock]`.
 *
 * - `keys` filters by position, an empty position matches any key.
 * - `chunkSize` is the page size, default 1000 (providers commonly cap it at 1024).
 * - `cursor` continues the range from a previous page.
 *
 * @since 0.1.0
 * @category models
 */
export interface StarknetEventsFilter {
  readonly address: StarknetAddress
  readonly fromBlock: bigint
  readonly toBlock: bigint
  readonly keys?: ReadonlyArray<ReadonlyArray<string>> | undefined
  readonly chunkSize?: number | undefined
  readonly cursor?: StarknetEventsCursor | undefined
}

/**
 * One page of events. `cursor` is `undefined` when the range is done.
 *
 * @since 0.1.0
 * @category models
 */
export interface StarknetEventsPage {
  readonly events: ReadonlyArray<StarknetEvent>
  readonly cursor: StarknetEventsCursor | undefined
}

/**
 * The part of a confirmed transaction receipt an indexer needs. `events` are in emission order.
 *
 * @since 0.1.0
 * @category models
 */
export interface StarknetTransactionReceipt {
  readonly transactionHash: StarknetTransactionHash
  readonly blockNumber: bigint
  readonly blockHash: string
  readonly events: ReadonlyArray<Pick<StarknetEvent, "fromAddress" | "keys" | "data">>
}

/**
 * @since 0.1.0
 * @category services
 */
export class StarknetRpc extends Context.Service<StarknetRpc, {
  readonly network: StarknetNetwork.StarknetNetwork
  /** `starknet_chainId`, verified against `network` once per endpoint then served from that check. */
  readonly chainId: Effect.Effect<StarknetNetwork.StarknetChainId, StarknetRpcError>
  /** `starknet_blockNumber` */
  readonly blockNumber: Effect.Effect<bigint, StarknetRpcError>
  /**
   * `starknet_getBlockWithTxHashes`, only answered by an endpoint whose head has reached `blockNumber`. A pre-confirmed
   * block fails with `InvalidResponse`.
   */
  readonly getBlockWithTxHashes: (
    params: { readonly blockNumber: bigint }
  ) => Effect.Effect<StarknetBlock, StarknetRpcError>
  /**
   * `starknet_getEvents`, one page, only answered by an endpoint whose head has reached `toBlock`. Events keep the
   * provider's order, which is chain order (`event_index` is not always returned to sort them). A pre-confirmed or
   * out-of-filter event fails with `InvalidResponse`, and an empty range returns no events.
   */
  readonly getEvents: (filter: StarknetEventsFilter) => Effect.Effect<StarknetEventsPage, StarknetRpcError>
  /** `starknet_getTransactionReceipt`. A pre-confirmed receipt fails with `InvalidResponse`. */
  readonly getTransactionReceipt: (
    params: { readonly transactionHash: StarknetTransactionHash }
  ) => Effect.Effect<StarknetTransactionReceipt, StarknetRpcError>
}>()("@effect-blockchain/starknet/StarknetRpc") {}

// error codes from the Starknet JSON-RPC spec v0.9 (starknet_api_openrpc.json), plus the common provider ones
const codes: ReadonlyMap<number, JsonRpc.CodeReason> = new Map([
  // UNEXPECTED_ERROR, JSON-RPC internal error and provider rate limits: the endpoint is struggling, retry then fall back
  [63, "Unavailable"],
  [-32603, "Unavailable"],
  [-32005, "Unavailable"],
  [429, "Unavailable"],
  // BLOCK_NOT_FOUND, TXN_HASH_NOT_FOUND: another endpoint may be further ahead
  [24, "Lagging"],
  [29, "Lagging"]
])

/**
 * Builds a {@link StarknetRpc} over `endpoints`, tried in order, sending requests with the provided `HttpClient`
 * (e.g. `FetchHttpClient.layer`). `timeout` (default 30 seconds) bounds each attempt, `retries` (default 3) and
 * `retryDelay` (default 500 millis) set the backoff before falling back: see {@link JsonRpc.Unavailable}.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer = (options: {
  readonly network: StarknetNetwork.StarknetNetwork
  readonly endpoints: Arr.NonEmptyReadonlyArray<StarknetRpcEndpoint>
  readonly timeout?: Duration.Input | undefined
  readonly retries?: number | undefined
  readonly retryDelay?: Duration.Input | undefined
}): Layer.Layer<StarknetRpc, never, HttpClient.HttpClient> =>
  Layer.effect(
    StarknetRpc,
    Effect.gen(function*() {
      const { network } = options
      const expectedChainId = StarknetNetwork.toChainId(network)

      const rpc = yield* JsonRpc.make({
        spanPrefix: "StarknetRpc",
        network,
        endpoints: options.endpoints,
        timeout: options.timeout,
        retries: options.retries,
        retryDelay: options.retryDelay,
        codes,
        checkNetwork: (send, endpoint) =>
          send(RpcMethods.chainId, {}).pipe(
            Effect.flatMap((chainId) =>
              chainId === expectedChainId
                ? Effect.succeed(expectedChainId)
                : Effect.fail(
                  new StarknetRpcError({
                    reason: new JsonRpc.WrongNetwork({ expected: expectedChainId, actual: chainId }),
                    method: RpcMethods.chainId.name,
                    endpoint,
                    cause: new Error(`expected chain ID ${expectedChainId} for ${network}, got ${chainId}`)
                  })
                )
            )
          ),
        makeError: (fields: JsonRpc.ErrorFields) => new StarknetRpcError(fields)
      })
      type Endpoint = JsonRpc.Endpoint<StarknetNetwork.StarknetChainId, StarknetRpcError>

      const blockNumberOn = (endpoint: Endpoint) =>
        rpc.call(endpoint, RpcMethods.blockNumber, {}).pipe(
          Effect.tap((head) => Ref.update(endpoint.head, (known) => head > known ? head : known))
        )

      const getEventsOn = (endpoint: Endpoint, filter: StarknetEventsFilter) =>
        Effect.gen(function*() {
          const method = RpcMethods.getEvents.name
          yield* rpc.guard(endpoint, method, filter.toBlock, blockNumberOn(endpoint))
          const page = yield* rpc.call(endpoint, RpcMethods.getEvents, {
            filter: {
              address: filter.address,
              from_block: { block_number: filter.fromBlock },
              to_block: { block_number: filter.toBlock },
              ...(filter.keys !== undefined && { keys: filter.keys }),
              chunk_size: filter.chunkSize ?? 1000,
              ...(filter.cursor !== undefined && { continuation_token: filter.cursor.cursor })
            }
          })
          const invalid = page.events.find((event) =>
            event.blockNumber < filter.fromBlock || event.blockNumber > filter.toBlock ||
            event.fromAddress !== filter.address
          )
          if (invalid !== undefined) {
            return yield* rpc.fail(
              endpoint,
              method,
              new JsonRpc.InvalidResponse(),
              new Error(`event of ${invalid.transactionHash} in block ${invalid.blockNumber} is outside the filter`)
            )
          }
          return {
            events: page.events,
            cursor: page.continuation_token === undefined ? undefined : StarknetEventsCursor.make({
              endpoint: endpoint.name,
              cursor: page.continuation_token
            })
          }
        })

      const getEvents = (filter: StarknetEventsFilter): Effect.Effect<StarknetEventsPage, StarknetRpcError> => {
        if (filter.fromBlock > filter.toBlock) return Effect.succeed({ events: [], cursor: undefined })
        if (filter.cursor === undefined) return rpc.withFallback((endpoint) => getEventsOn(endpoint, filter))
        // a cursor only means something to the endpoint that issued it
        return rpc.endpointOf(RpcMethods.getEvents.name, filter.cursor).pipe(
          Effect.flatMap((endpoint) => getEventsOn(endpoint, filter))
        )
      }

      return StarknetRpc.of({
        network,
        chainId: rpc.withFallback(rpc.checkNetwork),
        blockNumber: rpc.withFallback(blockNumberOn),
        getBlockWithTxHashes: ({ blockNumber }) =>
          rpc.withFallback((endpoint) =>
            rpc.guard(endpoint, RpcMethods.getBlockWithTxHashes.name, blockNumber, blockNumberOn(endpoint)).pipe(
              Effect.andThen(
                rpc.call(endpoint, RpcMethods.getBlockWithTxHashes, { block_id: { block_number: blockNumber } })
              )
            )
          ),
        getEvents,
        getTransactionReceipt: ({ transactionHash }) =>
          rpc.withFallback((endpoint) =>
            rpc.call(endpoint, RpcMethods.getTransactionReceipt, { transaction_hash: transactionHash })
          )
      })
    })
  )

/**
 * Builds an {@link StarknetRpc} like {@link layer}, reading the options from `Config`. Endpoint URLs stay `Redacted`.
 *
 * @example
 * ```ts
 * import * as StarknetRpc from "@effect-blockchain/starknet/StarknetRpc"
 * import * as Config from "effect/Config"
 *
 * const RpcLive = StarknetRpc.layerConfig({
 *   network: Config.succeed("Starknet"),
 *   endpoints: Config.all([Config.all({ name: Config.succeed("main"), url: Config.Redacted("STARKNET_RPC_URL") })])
 * })
 * ```
 *
 * @since 0.1.0
 * @category layers
 */
export const layerConfig = (
  options: Config.Wrap<Parameters<typeof layer>[0]>
): Layer.Layer<StarknetRpc, Config.ConfigError, HttpClient.HttpClient> =>
  Layer.unwrap(Effect.map(Config.unwrap(options), layer))
