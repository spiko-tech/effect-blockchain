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
import type * as Arr from "effect/Array"
import type * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import { constTrue } from "effect/Function"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientError from "effect/http/HttpClientError"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as SynchronizedRef from "effect/SynchronizedRef"
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
 * | `Unavailable` | transport, timeout, HTTP error status, `UNEXPECTED_ERROR` (63), internal or rate-limit error codes, after the retries | yes |
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
  continuationToken: Schema.String
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
export interface StarknetEventFilter {
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
  readonly chainId: Effect.Effect<StarknetNetwork.StarknetNetworkInfo["chainId"], StarknetRpcError>
  /** `starknet_blockNumber` */
  readonly blockNumber: Effect.Effect<bigint, StarknetRpcError>
  /**
   * `starknet_getEvents`, one page, only answered by an endpoint whose head has reached `toBlock`. Events keep the
   * provider's order. A pre-confirmed or out-of-filter event fails with `InvalidResponse`. An empty range returns no
   * events. With a `cursor`, only the endpoint that returned it is asked.
   */
  readonly getEvents: (filter: StarknetEventFilter) => Effect.Effect<StarknetEventsPage, StarknetRpcError>
  /** `starknet_getTransactionReceipt`. A pre-confirmed receipt fails with `InvalidResponse`. */
  readonly getTransactionReceipt: (
    transactionHash: StarknetTransactionHash
  ) => Effect.Effect<StarknetTransactionReceipt, StarknetRpcError>
}>()("@effect-blockchain/starknet/StarknetRpc") {}

const fallbackReasons: ReadonlySet<StarknetRpcErrorReason> = new Set([
  "Unavailable",
  "InvalidResponse",
  "Lagging",
  "Pruned"
])

// error codes from the Starknet JSON-RPC spec v0.9 (starknet_api_openrpc.json), plus the common provider ones
// UNEXPECTED_ERROR, JSON-RPC internal error and provider rate limits: the endpoint is struggling, retry then fall back
const unavailableCodes: ReadonlySet<number> = new Set([63, -32603, -32005, 429])
// BLOCK_NOT_FOUND, TXN_HASH_NOT_FOUND: another endpoint may be further ahead
const laggingCodes: ReadonlySet<number> = new Set([24, 29])

class JsonRpcError extends Data.TaggedError("JsonRpcError")<{ readonly code: number; readonly message: string }> {}

type SendError = HttpClientError.HttpClientError | Cause.TimeoutError | JsonRpcError

const isTransientRpcError = (error: unknown) => error instanceof JsonRpcError && unavailableCodes.has(error.code)

const classify = (
  error: SendError
): { readonly reason: StarknetRpcErrorReason; readonly code?: number | undefined } => {
  if (error instanceof JsonRpcError) {
    const reason = unavailableCodes.has(error.code)
      ? "Unavailable"
      : laggingCodes.has(error.code)
      ? "Lagging"
      : "Rejected"
    return { reason, code: error.code }
  }
  if (HttpClientError.isHttpClientError(error)) {
    switch (error.reason._tag) {
      case "StatusCodeError":
        return { reason: "Unavailable", code: error.reason.response.status }
      case "DecodeError":
      case "EmptyBodyError":
        return { reason: "InvalidResponse" }
    }
  }
  return { reason: "Unavailable" }
}

// HttpClientError messages carry the request URL: keep the reason and status only
const withoutUrl = (error: SendError): Error =>
  HttpClientError.isHttpClientError(error)
    ? new Error(
      `${error.reason._tag}${error.response === undefined ? "" : ` ${error.response.status}`}`,
      { cause: error.cause }
    )
    : error

type NetworkCheck = "Unchecked" | "Checked" | StarknetRpcError

/**
 * Builds a {@link StarknetRpc} over `endpoints`, tried in order, sending requests with the provided `HttpClient`
 * (e.g. `FetchHttpClient.layer`).
 *
 * - `timeout` bounds each attempt, default 30 seconds.
 * - `retries` is the number of retries per endpoint before falling back, default 3. Transport errors, timeouts, HTTP
 *   408/429/5xx and the `Unavailable` JSON-RPC codes are retried with an exponential backoff from `retryDelay`
 *   (default 500 millis) with jitter, honoring `Retry-After`.
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
      const expectedChainId = StarknetNetwork.starknetNetworks[network].chainId
      const timeout = options.timeout ?? Duration.seconds(30)

      const client = (yield* HttpClient.HttpClient).pipe(
        HttpClient.filterStatusOk,
        // a JSON-RPC error comes with HTTP 200: lift it into the error channel so that it can be retried
        HttpClient.transformResponse((response) =>
          response.pipe(
            Effect.tap((response) =>
              Effect.flatMap(response.json, (json) =>
                Option.match(Schema.decodeUnknownOption(RpcMethods.ErrorReply)(json), {
                  onNone: () => Effect.void,
                  onSome: ({ error }) => Effect.fail(new JsonRpcError(error))
                }))
            ),
            Effect.timeout(timeout)
          )
        ),
        HttpClient.retryTransient({
          retryOn: "errors-only",
          while: isTransientRpcError,
          schedule: Schedule.exponential(options.retryDelay ?? Duration.millis(500)).pipe(Schedule.jittered),
          times: options.retries ?? 3
        })
      )

      const endpoints = yield* Effect.forEach(options.endpoints, (endpoint) =>
        Effect.gen(function*() {
          return {
            name: endpoint.name,
            url: Redacted.value(endpoint.url),
            networkCheck: yield* SynchronizedRef.make<NetworkCheck>("Unchecked"),
            head: yield* Ref.make(BigInt(-1))
          }
        }))
      type Endpoint = typeof endpoints[number]

      const fail = (endpoint: Endpoint, method: string, reason: StarknetRpcErrorReason, cause: Error) =>
        new StarknetRpcError({ reason, method, endpoint: endpoint.name, cause })

      const send = <Params, A>(endpoint: Endpoint, method: RpcMethods.RpcMethod<Params, A>, params: Params) =>
        Effect.gen(function*() {
          const encoded = yield* Schema.encodeEffect(method.params)(params).pipe(
            Effect.mapError((cause) => fail(endpoint, method.name, "Rejected", cause))
          )
          const json = yield* HttpClientRequest.post(endpoint.url).pipe(
            HttpClientRequest.bodyJsonUnsafe({ jsonrpc: "2.0", id: 1, method: method.name, params: encoded }),
            client.execute,
            Effect.flatMap((response) => response.json),
            Effect.mapError((error) =>
              new StarknetRpcError({
                ...classify(error),
                method: method.name,
                endpoint: endpoint.name,
                cause: withoutUrl(error)
              })
            ),
            // the client span would record the URL
            Effect.provideService(HttpClient.TracerDisabledWhen, constTrue)
          )
          const reply = yield* Schema.decodeUnknownEffect(Schema.Struct({ result: method.result }))(json).pipe(
            Effect.mapError((cause) => fail(endpoint, method.name, "InvalidResponse", cause))
          )
          return reply.result
        }).pipe(
          Effect.withSpan(`StarknetRpc.${method.name}`, {
            attributes: { network, endpoint: endpoint.name, method: method.name }
          })
        )

      // a mismatch is kept, a failed check is not: the next call checks again
      const checkNetwork = (endpoint: Endpoint) =>
        SynchronizedRef.modifyEffect(endpoint.networkCheck, (state) =>
          state !== "Unchecked"
            ? Effect.succeed([state, state] as const)
            : send(endpoint, RpcMethods.chainId, {}).pipe(
              Effect.map((chainId): NetworkCheck =>
                chainId === expectedChainId ?
                  "Checked" :
                  fail(
                    endpoint,
                    RpcMethods.chainId.name,
                    "WrongNetwork",
                    new Error(`expected chain ID ${expectedChainId} for ${network}, got ${chainId}`)
                  )
              ),
              Effect.map((checked) => [checked, checked] as const)
            )).pipe(Effect.flatMap((state) => state instanceof StarknetRpcError ? Effect.fail(state) : Effect.void))

      const call = <Params, A>(endpoint: Endpoint, method: RpcMethods.RpcMethod<Params, A>, params: Params) =>
        checkNetwork(endpoint).pipe(Effect.andThen(send(endpoint, method, params)))

      const withFallback = Effect.fnUntraced(function*<A>(
        f: (endpoint: Endpoint) => Effect.Effect<A, StarknetRpcError>
      ): Effect.fn.Return<A, StarknetRpcError> {
        const errors: Array<StarknetRpcError> = []
        for (const endpoint of endpoints) {
          const result = yield* Effect.result(f(endpoint))
          if (Result.isSuccess(result)) return result.success
          errors.push(result.failure)
          if (!fallbackReasons.has(result.failure.reason)) break
        }
        const last = errors[errors.length - 1]
        if (errors.length === 1) return yield* last
        return yield* new StarknetRpcError({
          reason: last.reason,
          method: last.method,
          endpoint: last.endpoint,
          code: last.code,
          cause: new AggregateError(errors, `${errors.length} endpoints failed`)
        })
      })

      const blockNumberOn = (endpoint: Endpoint) =>
        call(endpoint, RpcMethods.blockNumber, {}).pipe(
          Effect.tap((head) => Ref.update(endpoint.head, (known) => head > known ? head : known))
        )

      const getEventsOn = (endpoint: Endpoint, filter: StarknetEventFilter) =>
        Effect.gen(function*() {
          const method = RpcMethods.getEvents.name
          if ((yield* Ref.get(endpoint.head)) < filter.toBlock) {
            const head = yield* blockNumberOn(endpoint)
            if (head < filter.toBlock) {
              return yield* fail(
                endpoint,
                method,
                "Lagging",
                new Error(`head ${head} is below toBlock ${filter.toBlock}`)
              )
            }
          }
          const page = yield* call(endpoint, RpcMethods.getEvents, {
            filter: {
              address: filter.address,
              from_block: { block_number: filter.fromBlock },
              to_block: { block_number: filter.toBlock },
              ...(filter.keys !== undefined && { keys: filter.keys }),
              chunk_size: filter.chunkSize ?? 1000,
              ...(filter.cursor !== undefined && { continuation_token: filter.cursor.continuationToken })
            }
          })
          const invalid = page.events.find((event) =>
            event.blockNumber < filter.fromBlock || event.blockNumber > filter.toBlock ||
            event.fromAddress !== filter.address
          )
          if (invalid !== undefined) {
            return yield* fail(
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
              continuationToken: page.continuation_token
            })
          }
        })

      const getEvents = (filter: StarknetEventFilter): Effect.Effect<StarknetEventsPage, StarknetRpcError> => {
        const { cursor } = filter
        if (filter.fromBlock > filter.toBlock) return Effect.succeed({ events: [], cursor: undefined })
        if (cursor === undefined) return withFallback((endpoint) => getEventsOn(endpoint, filter))
        // a continuation token only means something to the endpoint that issued it
        const endpoint = endpoints.find((endpoint) => endpoint.name === cursor.endpoint)
        return endpoint === undefined
          ? Effect.fail(
            new StarknetRpcError({
              reason: "Rejected",
              method: RpcMethods.getEvents.name,
              endpoint: cursor.endpoint,
              cause: new Error(`unknown endpoint ${cursor.endpoint} in cursor`)
            })
          )
          : getEventsOn(endpoint, filter)
      }

      return StarknetRpc.of({
        network,
        chainId: withFallback((endpoint) => checkNetwork(endpoint).pipe(Effect.as(expectedChainId))),
        blockNumber: withFallback(blockNumberOn),
        getEvents,
        getTransactionReceipt: (transactionHash) =>
          withFallback((endpoint) =>
            call(endpoint, RpcMethods.getTransactionReceipt, { transaction_hash: transactionHash })
          )
      })
    })
  )
