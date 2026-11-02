/**
 * Typed, read-only standard EVM JSON-RPC methods, served by an ordered list of endpoints with fallback.
 *
 * Every call starts at the first endpoint. An endpoint failure that another endpoint could answer (see
 * {@link EvmRpcError}) moves to the next endpoint, any other failure stops at once. Before its first call, each
 * endpoint is checked to serve the configured network (`eth_chainId`), once.
 *
 * Every method is a read and safe to repeat, which is what makes the fallback and the HTTP retries sound. A future
 * write method (e.g. `eth_sendRawTransaction`) must take a transaction signed outside this module, resend the same
 * signed bytes on fallback, never retry blindly after an unclear failure and confirm the outcome by transaction hash.
 *
 * Adding a method takes three steps:
 * 1. define it once in `internal/rpcMethods.ts`: its JSON-RPC name, a params codec and a result codec,
 * 2. add one line to the {@link EvmRpc} service and its layer, calling it through the shared `call`, which does the
 *    network check, the request, the error classification, the decoding and the span,
 * 3. add one test decoding a fake response.
 *
 * Methods are named after the JSON-RPC method without its namespace (`eth_getLogs` is `getLogs`).
 *
 * @since 0.1.0
 */
import * as Arr from "effect/Array"
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
import * as Order from "effect/Order"
import * as Redacted from "effect/Redacted"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as SynchronizedRef from "effect/SynchronizedRef"
import type { EvmAddress } from "./EvmAddress.ts"
import type { EvmHexData } from "./EvmHexData.ts"
import type { EvmLog } from "./EvmLog.ts"
import * as EvmNetwork from "./EvmNetwork.ts"
import * as RpcMethods from "./internal/rpcMethods.ts"

/**
 * A JSON-RPC endpoint. The `name` is shown in errors and spans, the `url` is never logged.
 *
 * @since 0.1.0
 * @category models
 */
export interface EvmRpcEndpoint {
  readonly name: string
  readonly url: Redacted.Redacted<string>
}

/**
 * Why a call failed:
 *
 * | reason | meaning | falls back to the next endpoint |
 * |---|---|---|
 * | `Unavailable` | transport, attempt timeout, HTTP error status, rate-limit or internal error codes, after the retries | yes |
 * | `InvalidResponse` | the reply is not JSON or fails its schema, or a log fails the `getLogs` checks | yes |
 * | `Lagging` | the endpoint's head is below the requested `toBlock` | yes |
 * | `Pruned` | the endpoint lacks the requested history (unused on EVM for now) | yes |
 * | `Rejected` | any other JSON-RPC error: every endpoint would answer the same | no |
 * | `WrongNetwork` | the endpoint's `eth_chainId` is not the configured network's | no |
 *
 * @since 0.1.0
 * @category models
 */
export const EvmRpcErrorReason = Schema.Literals([
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
export type EvmRpcErrorReason = typeof EvmRpcErrorReason.Type

/**
 * A failed call. `code` is the JSON-RPC error code or the HTTP status when there is one, and `cause` never contains
 * the endpoint URL. When several endpoints were tried, the error is the last one and its `cause` is an
 * `AggregateError` of every endpoint's error, in order.
 *
 * @since 0.1.0
 * @category errors
 */
export class EvmRpcError extends Schema.TaggedError<EvmRpcError>()("EvmRpcError", {
  reason: EvmRpcErrorReason,
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
 * An `eth_getLogs` filter over the inclusive block range `[fromBlock, toBlock]`.
 *
 * @since 0.1.0
 * @category models
 */
export interface EvmLogsFilter {
  readonly address: EvmAddress | ReadonlyArray<EvmAddress>
  readonly fromBlock: bigint
  readonly toBlock: bigint
  readonly topics?: ReadonlyArray<EvmHexData | ReadonlyArray<EvmHexData> | null> | undefined
}

/**
 * @since 0.1.0
 * @category services
 */
export class EvmRpc extends Context.Service<EvmRpc, {
  readonly network: EvmNetwork.EvmNetwork
  /** `eth_chainId`, verified against `network` once per endpoint then served from that check. */
  readonly chainId: Effect.Effect<EvmNetwork.EvmChainId, EvmRpcError>
  /** `eth_blockNumber` */
  readonly blockNumber: Effect.Effect<bigint, EvmRpcError>
  /**
   * `eth_getLogs`, only answered by an endpoint whose head has reached `toBlock`. Logs are returned in chain order:
   * sorted by block then log index. A removed, pending or out-of-filter log fails with `InvalidResponse`. An empty
   * range returns `[]`.
   */
  readonly getLogs: (filter: EvmLogsFilter) => Effect.Effect<ReadonlyArray<EvmLog>, EvmRpcError>
}>()("@effect-blockchain/evm/EvmRpc") {}

const fallbackReasons: ReadonlySet<EvmRpcErrorReason> = new Set([
  "Unavailable",
  "InvalidResponse",
  "Lagging",
  "Pruned"
])

// the JSON-RPC codes viem 2.57.11 retries (`utils/buildRequest.ts`, `shouldRetry`): limit exceeded, internal error,
// QuickNode rate limit, unknown error and Alchemy's batch rate limit. The endpoint is struggling: retry then fall back
const unavailableCodes: ReadonlySet<number> = new Set([-32005, -32603, -32007, -1, 429])

class JsonRpcError extends Data.TaggedError("JsonRpcError")<{ readonly code: number; readonly message: string }> {}

// not a `Cause.TimeoutError`, which `retryTransient` always retries: a timed-out attempt falls back at once
class AttemptTimeout extends Data.TaggedError("AttemptTimeout")<{ readonly timeout: Duration.Duration }> {
  override get message(): string {
    return `timed out after ${Duration.format(this.timeout)}`
  }
}

type SendError = HttpClientError.HttpClientError | AttemptTimeout | JsonRpcError

const isTransientRpcError = (error: unknown) => error instanceof JsonRpcError && unavailableCodes.has(error.code)

const classify = (
  error: SendError
): { readonly reason: EvmRpcErrorReason; readonly code?: number | undefined } => {
  if (error instanceof JsonRpcError) {
    return { reason: unavailableCodes.has(error.code) ? "Unavailable" : "Rejected", code: error.code }
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

// HttpClientError messages and causes can carry the request URL: keep the reason and status only
const withoutUrl = (error: SendError): Error =>
  HttpClientError.isHttpClientError(error)
    ? new Error(`${error.reason._tag}${error.response === undefined ? "" : ` ${error.response.status}`}`)
    : error

const byBlockThenIndex = Order.combine(
  Order.mapInput(Order.BigInt, (log: EvmLog) => log.blockNumber),
  Order.mapInput(Order.Number, (log: EvmLog) => log.logIndex)
)

type NetworkCheck = "Unchecked" | "Checked" | EvmRpcError

/**
 * Builds an {@link EvmRpc} over `endpoints`, tried in order, sending requests with the provided `HttpClient`
 * (e.g. `FetchHttpClient.layer`).
 *
 * - `timeout` bounds each attempt, default 30 seconds. A timed-out attempt is not retried: the call moves to the next
 *   endpoint at once.
 * - `retries` is the number of retries per endpoint before falling back, default 3. Transport errors, HTTP
 *   408/429/500/502/503/504 and the `Unavailable` JSON-RPC codes (-32005, -32603, -32007, -1, 429) are retried with an
 *   exponential backoff from `retryDelay` (default 500 millis) with jitter, honoring `Retry-After`. Any other HTTP
 *   status (e.g. 403) is not retried and falls back at once.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer = (options: {
  readonly network: EvmNetwork.EvmNetwork
  readonly endpoints: Arr.NonEmptyReadonlyArray<EvmRpcEndpoint>
  readonly timeout?: Duration.Input | undefined
  readonly retries?: number | undefined
  readonly retryDelay?: Duration.Input | undefined
}): Layer.Layer<EvmRpc, never, HttpClient.HttpClient> =>
  Layer.effect(
    EvmRpc,
    Effect.gen(function*() {
      const { network } = options
      const expectedChainId = EvmNetwork.toChainId(network)
      const timeout = Duration.fromInputUnsafe(options.timeout ?? Duration.seconds(30))

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
            Effect.timeoutOrElse({
              duration: timeout,
              orElse: () =>
                Effect.fail(new AttemptTimeout({ timeout }))
            })
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

      const fail = (endpoint: Endpoint, method: string, reason: EvmRpcErrorReason, cause: Error) =>
        new EvmRpcError({ reason, method, endpoint: endpoint.name, cause })

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
              new EvmRpcError({
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
          Effect.withSpan(`EvmRpc.${method.name}`, {
            attributes: { network, endpoint: endpoint.name, method: method.name }
          })
        )

      // a mismatch is kept, a failed check is not: the next call checks again
      const checkNetwork = (endpoint: Endpoint) =>
        SynchronizedRef.modifyEffect(endpoint.networkCheck, (state) =>
          state !== "Unchecked"
            ? Effect.succeed([state, state] as const)
            : send(endpoint, RpcMethods.chainId, []).pipe(
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
            )).pipe(Effect.flatMap((state) => state instanceof EvmRpcError ? Effect.fail(state) : Effect.void))

      const call = <Params, A>(endpoint: Endpoint, method: RpcMethods.RpcMethod<Params, A>, params: Params) =>
        checkNetwork(endpoint).pipe(Effect.andThen(send(endpoint, method, params)))

      const withFallback = Effect.fnUntraced(function*<A>(
        f: (endpoint: Endpoint) => Effect.Effect<A, EvmRpcError>
      ): Effect.fn.Return<A, EvmRpcError> {
        const errors: Array<EvmRpcError> = []
        for (const endpoint of endpoints) {
          const result = yield* Effect.result(f(endpoint))
          if (Result.isSuccess(result)) return result.success
          errors.push(result.failure)
          if (!fallbackReasons.has(result.failure.reason)) break
        }
        const last = errors[errors.length - 1]
        if (errors.length === 1) return yield* last
        return yield* new EvmRpcError({
          reason: last.reason,
          method: last.method,
          endpoint: last.endpoint,
          code: last.code,
          cause: new AggregateError(errors, `${errors.length} endpoints failed`)
        })
      })

      const blockNumberOn = (endpoint: Endpoint) =>
        call(endpoint, RpcMethods.blockNumber, []).pipe(
          Effect.tap((head) => Ref.update(endpoint.head, (known) => head > known ? head : known))
        )

      // the head guard: ask for the head only when the known one is below `toBlock`
      const guard = (endpoint: Endpoint, method: string, toBlock: bigint) =>
        Effect.gen(function*() {
          if ((yield* Ref.get(endpoint.head)) >= toBlock) return
          const head = yield* blockNumberOn(endpoint)
          if (head < toBlock) {
            return yield* fail(endpoint, method, "Lagging", new Error(`head ${head} is below toBlock ${toBlock}`))
          }
        })

      const getLogsOn = (endpoint: Endpoint, filter: EvmLogsFilter) =>
        Effect.gen(function*() {
          const method = RpcMethods.getLogs.name
          yield* guard(endpoint, method, filter.toBlock)
          const addresses = new Set<string>(Arr.ensure(filter.address))
          const logs = yield* call(endpoint, RpcMethods.getLogs, [filter])
          const invalid = logs.find((log) =>
            log.blockNumber < filter.fromBlock || log.blockNumber > filter.toBlock ||
            !addresses.has(log.address)
          )
          if (invalid !== undefined) {
            return yield* fail(
              endpoint,
              method,
              "InvalidResponse",
              new Error(`log ${invalid.transactionHash}#${invalid.logIndex} is outside the filter`)
            )
          }
          return Arr.sort(logs.map(({ removed: _removed, ...log }) => log), byBlockThenIndex)
        })

      return EvmRpc.of({
        network,
        chainId: withFallback((endpoint) => checkNetwork(endpoint).pipe(Effect.as(expectedChainId))),
        blockNumber: withFallback(blockNumberOn),
        getLogs: (filter) =>
          filter.fromBlock > filter.toBlock
            ? Effect.succeed([])
            : withFallback((endpoint) => getLogsOn(endpoint, filter))
      })
    })
  )
