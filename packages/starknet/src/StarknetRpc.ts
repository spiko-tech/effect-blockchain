/**
 * Typed, read-only standard Starknet JSON-RPC methods, served by an ordered list of endpoints with fallback.
 *
 * Every call starts at the first endpoint. An endpoint failure that another endpoint could answer (see
 * {@link StarknetRpcError}) moves to the next endpoint, any other failure stops at once. Before its first call, each
 * endpoint is checked to serve the configured network (`starknet_chainId`), once. A call that continues a
 * `starknet_getEvents` page goes to the endpoint that returned the cursor only.
 *
 * Every method is a read and safe to repeat, which is what makes the fallback and the HTTP retries sound. A future
 * write method (e.g. `starknet_addInvokeTransaction`) must take a transaction signed outside this module, resend the
 * same signed transaction on fallback, never retry blindly after an unclear failure and confirm the outcome by
 * transaction hash.
 *
 * Adding a method takes three steps:
 * 1. define it once in `internal/rpcMethods.ts`: its JSON-RPC name, a by-name params codec and a result codec,
 * 2. add one line to the {@link StarknetRpc} service and its layer, calling it through the shared `call`, which does
 *    the network check, the request, the error classification, the decoding and the span,
 * 3. add one test decoding a fake response.
 *
 * Methods are named after the JSON-RPC method without its namespace (`starknet_getEvents` is `getEvents`).
 *
 * @since 0.1.0
 */
import * as JsonRpc from "@effect-blockchain/core/JsonRpc"
import type * as Arr from "effect/Array"
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
 * Why a call failed:
 *
 * | reason | meaning | falls back to the next endpoint |
 * |---|---|---|
 * | `Unavailable` | transport, HTTP error status, `UNEXPECTED_ERROR` (63), internal or rate-limit error codes, after the retries, or a timeout (not retried) | yes |
 * | `InvalidResponse` | the reply is not JSON or fails its schema, or an event fails the `getEvents` checks | yes |
 * | `Lagging` | the endpoint's head is below the requested `toBlock`, or it answers `BLOCK_NOT_FOUND` (24) or `TXN_HASH_NOT_FOUND` (29) | yes |
 * | `Pruned` | the endpoint lacks the requested history (unused on Starknet for now) | yes |
 * | `Rejected` | any other JSON-RPC error, e.g. `PAGE_SIZE_TOO_BIG` (31), `INVALID_CONTINUATION_TOKEN` (33), `TOO_MANY_KEYS_IN_FILTER` (34) | no |
 * | `WrongNetwork` | the endpoint's `starknet_chainId` is not the configured network's | no |
 *
 * @since 0.1.0
 * @category models
 */
export const StarknetRpcErrorReason = Schema.Literals([
  "Unavailable",
  "InvalidResponse",
  "Lagging",
  "Pruned",
  "Rejected",
  "WrongNetwork"
])

/**
 * @since 0.1.0
 * @category models
 */
export type StarknetRpcErrorReason = typeof StarknetRpcErrorReason.Type

/**
 * A failed call. `code` is the JSON-RPC error code or the HTTP status when there is one, and `cause` never contains
 * the endpoint URL. When several endpoints were tried, the error is the last one and its `cause` is an
 * `AggregateError` of every endpoint's error, in order.
 *
 * @since 0.1.0
 * @category errors
 */
export class StarknetRpcError extends Schema.TaggedError<StarknetRpcError>()("StarknetRpcError", {
  reason: StarknetRpcErrorReason,
  method: Schema.String,
  endpoint: Schema.String,
  code: Schema.optional(Schema.Number),
  cause: Schema.Defect()
}) {
  /**
   * @since 0.1.0
   */
  override get message(): string {
    return `${this.method} failed on ${this.endpoint}: ${this.reason}${
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
   * `starknet_getEvents`, one page, only answered by an endpoint whose head has reached `toBlock`. Events are in chain
   * order: the provider's order, which is chain order (they are not sorted, as `event_index` is not always returned).
   * A pre-confirmed or out-of-filter event fails with `InvalidResponse`. An empty range returns no events. With a
   * `cursor`, only the endpoint that returned it is asked.
   */
  readonly getEvents: (filter: StarknetEventsFilter) => Effect.Effect<StarknetEventsPage, StarknetRpcError>
  /** `starknet_getTransactionReceipt`. A pre-confirmed receipt fails with `InvalidResponse`. */
  readonly getTransactionReceipt: (
    params: { readonly transactionHash: StarknetTransactionHash }
  ) => Effect.Effect<StarknetTransactionReceipt, StarknetRpcError>
}>()("@effect-blockchain/starknet/StarknetRpc") {}

// error codes from the Starknet JSON-RPC spec v0.9 (starknet_api_openrpc.json), plus the common provider ones
const codes: ReadonlyMap<number, JsonRpc.Reason> = new Map([
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
 * (e.g. `FetchHttpClient.layer`).
 *
 * - `timeout` bounds each attempt, default 30 seconds. A timed-out attempt is not retried: the call moves to the next
 *   endpoint at once.
 * - `retries` is the number of retries per endpoint before falling back, default 3. Transport errors, HTTP
 *   408/429/500/502/503/504 and the `Unavailable` JSON-RPC codes (63, -32603, -32005, 429) are retried with an
 *   exponential backoff from `retryDelay` (default 500 millis) with jitter, honoring `Retry-After`. Any other HTTP
 *   status (e.g. 403) is not retried and falls back at once.
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
                    reason: "WrongNetwork",
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
              "InvalidResponse",
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
        getEvents,
        getTransactionReceipt: ({ transactionHash }) =>
          rpc.withFallback((endpoint) =>
            rpc.call(endpoint, RpcMethods.getTransactionReceipt, { transaction_hash: transactionHash })
          )
      })
    })
  )
