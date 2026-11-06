/**
 * The shared JSON-RPC engine of the `@effect-blockchain` chain packages. Import it for the reasons a chain error
 * carries and for the RPC metrics.
 *
 * Every chain error (`EvmRpcError`, `SolanaRpcError`, `StarknetRpcError`, `StellarRpcError`) has a `reason`, matched
 * with `Effect.catchReason`. The metrics are recorded with `effect/Metric`, free when nobody reads them, and their
 * attributes hold the endpoint name, never its URL.
 *
 * @example
 * ```ts
 * import * as JsonRpc from "@effect-blockchain/core/JsonRpc"
 * import * as Effect from "effect/Effect"
 * import * as Schema from "effect/Schema"
 *
 * // shaped like the chain errors
 * class ChainRpcError extends Schema.TaggedError<ChainRpcError>()("ChainRpcError", { reason: JsonRpc.Reason }) {}
 *
 * declare const getLogs: Effect.Effect<ReadonlyArray<string>, ChainRpcError>
 *
 * // no endpoint keeps this range: read nothing, any other reason stays a ChainRpcError
 * const logs = getLogs.pipe(Effect.catchReason("ChainRpcError", "Pruned", () => Effect.succeed([])))
 * ```
 *
 * @since 0.1.0
 */
import type * as Arr from "effect/Array"
import * as BigInt_ from "effect/BigInt"
import * as Clock from "effect/Clock"
import * as Data from "effect/Data"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import { constTrue } from "effect/Function"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientError from "effect/http/HttpClientError"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import type * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Metric from "effect/Metric"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as SynchronizedRef from "effect/SynchronizedRef"

/**
 * The endpoint could not answer: transport error, attempt timeout, HTTP error status without a JSON-RPC error, or a
 * JSON-RPC code the chain maps to `Unavailable`. Transport errors, HTTP 408/429/500/502/503/504 and those codes are
 * retried on the same endpoint with a jittered exponential backoff honoring `Retry-After`, a timed-out attempt is not.
 * `status` is the HTTP status when it is not 2xx.
 *
 * @since 0.1.0
 * @category reasons
 */
export class Unavailable extends Schema.TaggedError<Unavailable>()("Unavailable", {
  status: Schema.optional(Schema.Number)
}) {}

/**
 * The reply is not JSON or fails its schema.
 *
 * @since 0.1.0
 * @category reasons
 */
export class InvalidResponse extends Schema.TaggedError<InvalidResponse>()("InvalidResponse", {}) {}

/**
 * The endpoint is behind the requested block. `head` (the endpoint's) and `toBlock` (the requested one) are set when
 * known, unset when the endpoint answered a `Lagging` JSON-RPC code.
 *
 * @since 0.1.0
 * @category reasons
 */
export class Lagging extends Schema.TaggedError<Lagging>()("Lagging", {
  head: Schema.optional(Schema.BigInt),
  toBlock: Schema.optional(Schema.BigInt)
}) {}

/**
 * The endpoint lacks the requested history.
 *
 * @since 0.1.0
 * @category reasons
 */
export class Pruned extends Schema.TaggedError<Pruned>()("Pruned", {}) {}

/**
 * Any other JSON-RPC error, or params that do not encode.
 *
 * @since 0.1.0
 * @category reasons
 */
export class Rejected extends Schema.TaggedError<Rejected>()("Rejected", {}) {}

/**
 * The endpoint does not serve the configured network: `expected` is the configured network's identifier, `actual`
 * the endpoint's.
 *
 * @since 0.1.0
 * @category reasons
 */
export class WrongNetwork extends Schema.TaggedError<WrongNetwork>()("WrongNetwork", {
  expected: Schema.String,
  actual: Schema.String
}) {}

/**
 * Why a call failed, the `reason` of every chain error, matched with `Effect.catchReason` or `Effect.catchReasons`:
 *
 * | reason | meaning | falls back to the next endpoint |
 * |---|---|---|
 * | `Unavailable` | transport, attempt timeout, HTTP error status without a JSON-RPC error reply or an `Unavailable` JSON-RPC code, after the retries | yes |
 * | `InvalidResponse` | the reply is not JSON or fails its schema | yes |
 * | `Lagging` | the endpoint is behind the requested block | yes |
 * | `Pruned` | the endpoint lacks the requested history | yes |
 * | `Rejected` | any other JSON-RPC error, whatever the HTTP status, or params that do not encode. Not retried, as the same endpoint would answer the same, but providers disagree on limits (e.g. a block range): another may answer | yes |
 * | `WrongNetwork` | the endpoint does not serve the configured network | no |
 *
 * @since 0.1.0
 * @category reasons
 */
export const Reason = Schema.Union([Unavailable, InvalidResponse, Lagging, Pruned, Rejected, WrongNetwork])

/**
 * @since 0.1.0
 * @category reasons
 */
export type Reason = typeof Reason.Type

/**
 * The reasons a JSON-RPC error code maps to in `Options.codes`.
 *
 * @since 0.1.0
 * @category reasons
 * @internal
 */
export type CodeReason = Exclude<Reason["_tag"], "WrongNetwork">

/**
 * Whether a later attempt can fix `reason`: `Unavailable`, `InvalidResponse` and `Lagging`. The others answer the
 * same at the same block.
 *
 * @since 0.1.0
 * @category reasons
 */
export const isTransient = (reason: Reason): boolean =>
  reason._tag === "Unavailable" || reason._tag === "InvalidResponse" || reason._tag === "Lagging"

/**
 * What `makeError` receives. `cause` never contains the endpoint URL.
 *
 * @since 0.1.0
 * @category models
 * @internal
 */
export interface ErrorFields {
  readonly reason: Reason
  readonly method: string
  readonly endpoint: string
  readonly code?: number | undefined
  readonly cause: Error
}

/**
 * The part of a chain error the engine reads back.
 *
 * @since 0.1.0
 * @category models
 * @internal
 */
export type ErrorShape = Omit<ErrorFields, "cause">

/**
 * A JSON-RPC endpoint as configured. The `name` is shown in errors and spans and routes cursors, the `url` is never
 * logged.
 *
 * @since 0.1.0
 * @category models
 */
export interface EndpointConfig {
  readonly name: string
  readonly url: Redacted.Redacted<string>
}

/**
 * A configured endpoint and its state: the network check and the highest head it reported (-1 before any).
 *
 * @since 0.1.0
 * @category models
 * @internal
 */
export interface Endpoint<Info, E> extends EndpointConfig {
  readonly head: Ref.Ref<bigint>
  readonly networkCheck: SynchronizedRef.SynchronizedRef<Option.Option<Result.Result<Info, E>>>
}

/**
 * A JSON-RPC method: its name, the codec of its params (`undefined`: no `params` member is sent) and the codec of its
 * result, read from a body parsed by `parseBody`.
 *
 * @since 0.1.0
 * @category models
 * @internal
 */
export interface Method<Params, A, J = Schema.Json> {
  readonly name: string
  readonly params: Schema.Codec<Params, Schema.Json | undefined>
  readonly result: Schema.Codec<A, J>
}

/**
 * Sends one request to one endpoint, with no network check.
 *
 * @since 0.1.0
 * @category models
 * @internal
 */
export type Send<E, J = Schema.Json> = <Params, A>(method: Method<Params, A, J>, params: Params) => Effect.Effect<A, E>

/**
 * - `spanPrefix` names the spans: `${spanPrefix}.${method}`.
 * - `timeout` (default 30 seconds) bounds each attempt, `retries` (default 3) and `retryDelay` (default 500 millis)
 *   set the backoff: see {@link Unavailable}. HTTP 408/429/500/502/503/504 are retried, any other status only when its
 *   body is a JSON-RPC error with an `Unavailable` code.
 * - `codes` maps JSON-RPC error codes to a reason tag, any other code is `Rejected`, whatever the HTTP status of the
 *   reply. The code is the error's `code`, else the HTTP status of a non-2xx reply.
 * - `parseBody` parses a reply body, default `JSON.parse` (an empty body is `null`).
 * - `checkNetwork` asks `endpoint` for its network and fails `WrongNetwork` on a mismatch.
 * - `makeError` builds the chain's error. `E` is inferred from it alone, so annotate its parameter:
 *   `(fields: JsonRpc.ErrorFields) => new ChainRpcError(fields)`.
 *
 * @since 0.1.0
 * @category models
 * @internal
 */
export interface Options<Info, E, J = Schema.Json> {
  readonly spanPrefix: string
  readonly network: string
  readonly endpoints: Arr.NonEmptyReadonlyArray<EndpointConfig>
  readonly timeout?: Duration.Input | undefined
  readonly retries?: number | undefined
  readonly retryDelay?: Duration.Input | undefined
  readonly codes: ReadonlyMap<number, CodeReason>
  readonly parseBody?: ((text: string) => J) | undefined
  readonly checkNetwork: (send: Send<NoInfer<E>, J>, endpoint: string) => Effect.Effect<Info, NoInfer<E>>
  readonly makeError: (fields: ErrorFields) => E
}

/**
 * The engine built by {@link make}, used by each chain's RPC layer.
 *
 * @since 0.1.0
 * @category models
 * @internal
 */
export interface JsonRpc<Info, E, J = Schema.Json> {
  /** Builds the chain's error for `endpoint`. */
  readonly fail: (endpoint: Endpoint<Info, E>, method: string, reason: Reason, cause: Error) => E
  /** The network check, run once per endpoint, concurrent first calls included. */
  readonly checkNetwork: (endpoint: Endpoint<Info, E>) => Effect.Effect<Info, E>
  /** The network check then the request, its classification, decoding and span. */
  readonly call: <Params, A>(
    endpoint: Endpoint<Info, E>,
    method: Method<Params, A, J>,
    params: Params
  ) => Effect.Effect<A, E>
  /**
   * Runs `f` on each endpoint in order until one succeeds or fails with a reason that does not fall back. When
   * several endpoints were tried, the error is the last one with an `AggregateError` of every error as its `cause`.
   */
  readonly withFallback: <A>(f: (endpoint: Endpoint<Info, E>) => Effect.Effect<A, E>) => Effect.Effect<A, E>
  /** The endpoint that issued `cursor`, `Rejected` without a request when there is none. */
  readonly endpointOf: (
    method: string,
    cursor: { readonly endpoint: string }
  ) => Effect.Effect<Endpoint<Info, E>, E>
  /** Fails `Lagging` unless the endpoint's head reached `toBlock`, running `latest` only when the known head is below. */
  readonly guard: (
    endpoint: Endpoint<Info, E>,
    method: string,
    toBlock: bigint,
    latest: Effect.Effect<bigint, E>
  ) => Effect.Effect<void, E>
}

/**
 * `effect_blockchain_rpc_requests_total`: one per request to an endpoint, its HTTP retries included, by `network`,
 * `endpoint` (its name), `method` and `outcome` (`success` or the reason tag). A request interrupted or ended by a
 * defect is not counted, and params that do not encode send none.
 *
 * @since 0.1.0
 * @category metrics
 */
export const requestsMetric = Metric.counter("effect_blockchain_rpc_requests_total", {
  description: "JSON-RPC requests per endpoint attempt, by network, endpoint, method and outcome",
  incremental: true
})

/**
 * `effect_blockchain_rpc_request_duration`: the duration of each request counted by `requestsMetric`, in milliseconds,
 * HTTP retries included, with the same attributes.
 *
 * @since 0.1.0
 * @category metrics
 */
export const requestDurationMetric = Metric.timer("effect_blockchain_rpc_request_duration", {
  description: "JSON-RPC request duration in milliseconds, by network, endpoint, method and outcome"
})

/**
 * `effect_blockchain_rpc_fallbacks_total`: one each time a call moves to the next endpoint, by `network`, `endpoint`
 * (the one that failed), `method` and `outcome` (the reason tag that caused it).
 *
 * @since 0.1.0
 * @category metrics
 */
export const fallbacksMetric = Metric.counter("effect_blockchain_rpc_fallbacks_total", {
  description: "JSON-RPC fallbacks to the next endpoint, by network, failed endpoint, method and reason",
  incremental: true
})

const fromCode = { Unavailable, InvalidResponse, Lagging, Pruned, Rejected }

// `bigint` codes for a `parseBody` that reads integers as `bigint`
const ErrorReply = Schema.Struct({
  error: Schema.Struct({ code: Schema.Union([Schema.Number, Schema.BigInt]), message: Schema.String })
})

class JsonRpcError extends Data.TaggedError("JsonRpcError")<{ readonly code: number; readonly message: string }> {}

// not a `Cause.TimeoutError`, which `retryTransient` always retries: a timed-out attempt falls back at once
class AttemptTimeout extends Data.TaggedError("AttemptTimeout")<{ readonly timeout: Duration.Duration }> {
  override get message(): string {
    return `timed out after ${Duration.format(this.timeout)}`
  }
}

type SendError = HttpClientError.HttpClientError | AttemptTimeout | JsonRpcError

// HttpClientError messages and causes can carry the request URL: keep the reason, status and JSON-RPC error only
const withoutUrl = (error: SendError): Error =>
  HttpClientError.isHttpClientError(error)
    ? new Error(
      `${error.reason._tag}${error.response === undefined ? "" : ` ${error.response.status}`}`,
      error.reason.cause instanceof JsonRpcError ? { cause: error.reason.cause } : undefined
    )
    : error

/**
 * Builds the engine over `options.endpoints`, tried in order. Each endpoint's network is checked once before its first
 * call: a mismatch is kept, a failed check is retried on the next call.
 *
 * @since 0.1.0
 * @category constructors
 * @internal
 */
export const make = Effect.fnUntraced(function*<Info, E extends ErrorShape, J = Schema.Json>(
  options: Options<Info, E, J>
): Effect.fn.Return<JsonRpc<Info, E, J>, never, HttpClient.HttpClient> {
  const { codes, makeError, network } = options
  const timeout = Duration.fromInputUnsafe(options.timeout ?? Duration.seconds(30))
  // `response.json` reads an empty body as `null`
  const parse: (text: string) => J = options.parseBody ?? ((text) => JSON.parse(text === "" ? "null" : text))

  const bodyOf = (response: HttpClientResponse.HttpClientResponse) =>
    Effect.flatMap(response.text, (text) =>
      Effect.try({
        try: () => parse(text),
        catch: (cause) =>
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.DecodeError({ request: response.request, response, cause })
          })
      }))

  const jsonRpcErrorOf = (json: J) =>
    Option.map(
      Schema.decodeUnknownOption(ErrorReply)(json),
      ({ error }) => new JsonRpcError({ code: Number(error.code), message: error.message })
    )

  const classify = (error: SendError): { readonly reason: Reason; readonly code?: number | undefined } => {
    if (error instanceof JsonRpcError) {
      return { reason: new fromCode[codes.get(error.code) ?? "Rejected"](), code: error.code }
    }
    if (HttpClientError.isHttpClientError(error)) {
      switch (error.reason._tag) {
        case "StatusCodeError": {
          const status = error.reason.response.status
          const cause = error.reason.cause
          if (cause instanceof JsonRpcError) {
            const tag = codes.get(cause.code) ?? "Rejected"
            return {
              reason: tag === "Unavailable" ? new Unavailable({ status }) : new fromCode[tag](),
              code: cause.code
            }
          }
          return { reason: new Unavailable({ status }), code: status }
        }
        case "DecodeError":
        case "EmptyBodyError":
          return { reason: new InvalidResponse() }
      }
    }
    return { reason: new Unavailable() }
  }

  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.transformResponse((response) =>
      response.pipe(
        Effect.tap((response) =>
          response.status >= 200 && response.status < 300
            // a JSON-RPC error in a 2xx reply: lift it into the error channel so that it can be retried
            ? Effect.flatMap(
              bodyOf(response),
              (json) => Option.match(jsonRpcErrorOf(json), { onNone: () => Effect.void, onSome: Effect.fail })
            )
            // any other status: a status error, which `retryTransient` reads (transient statuses, `Retry-After`),
            // with the JSON-RPC error of its body, if any, as its cause
            : Effect.flatMap(Effect.option(bodyOf(response)), (json) =>
              Effect.fail(
                new HttpClientError.HttpClientError({
                  reason: new HttpClientError.StatusCodeError({
                    request: response.request,
                    response,
                    cause: Option.getOrUndefined(Option.flatMap(json, jsonRpcErrorOf)),
                    description: "non 2xx status code"
                  })
                })
              ))
        ),
        Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.fail(new AttemptTimeout({ timeout })) })
      )
    ),
    HttpClient.retryTransient({
      retryOn: "errors-only",
      // the `Unavailable` codes: the endpoint is struggling, retry then fall back
      while: (error) => {
        const cause = HttpClientError.isHttpClientError(error) && error.reason._tag === "StatusCodeError"
          ? error.reason.cause
          : error
        return cause instanceof JsonRpcError && codes.get(cause.code) === "Unavailable"
      },
      schedule: Schedule.exponential(options.retryDelay ?? Duration.millis(500)).pipe(Schedule.jittered),
      times: options.retries ?? 3
    })
  )

  const endpoints = yield* Effect.forEach(options.endpoints, (endpoint) =>
    Effect.gen(function*() {
      return {
        name: endpoint.name,
        url: endpoint.url,
        head: yield* Ref.make(BigInt(-1)),
        networkCheck: yield* SynchronizedRef.make(Option.none<Result.Result<Info, E>>())
      }
    }))
  type Endpoint = typeof endpoints[number]

  const fail = (endpoint: Endpoint, method: string, reason: Reason, cause: Error) =>
    makeError({ reason, method, endpoint: endpoint.name, cause })

  // records `requestsMetric` and `requestDurationMetric` when `request` succeeds or fails
  const recordRequestMetrics = <A>(endpoint: Endpoint, method: string, request: Effect.Effect<A, E>) =>
    Effect.flatMap(Clock.currentTimeMillis, (start) => {
      const recordOutcome = (outcome: string) =>
        Effect.flatMap(Clock.currentTimeMillis, (end) => {
          const attributes = { network, endpoint: endpoint.name, method, outcome }
          return Metric.update(Metric.withAttributes(requestsMetric, attributes), 1).pipe(
            Effect.andThen(
              Metric.update(Metric.withAttributes(requestDurationMetric, attributes), Duration.millis(end - start))
            )
          )
        })
      return request.pipe(
        Effect.tap(() => recordOutcome("success")),
        Effect.tapError((error) => recordOutcome(error.reason._tag))
      )
    })

  const send = <Params, A>(endpoint: Endpoint, method: Method<Params, A, J>, params: Params) =>
    Effect.gen(function*() {
      const encoded = yield* Schema.encodeEffect(method.params)(params).pipe(
        Effect.mapError((cause) => fail(endpoint, method.name, new Rejected(), cause))
      )
      // one request per HTTP call: the id is never matched
      return yield* HttpClientRequest.post(Redacted.value(endpoint.url)).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          jsonrpc: "2.0",
          id: 1,
          method: method.name,
          ...(encoded === undefined ? {} : { params: encoded })
        }),
        client.execute,
        Effect.flatMap(bodyOf),
        Effect.mapError((error) =>
          makeError({ ...classify(error), method: method.name, endpoint: endpoint.name, cause: withoutUrl(error) })
        ),
        // the client span would record the URL: this module's span replaces it
        Effect.provideService(HttpClient.TracerDisabledWhen, constTrue),
        Effect.flatMap((json) =>
          Schema.decodeUnknownEffect(Schema.Struct({ result: method.result }))(json).pipe(
            Effect.mapError((cause) => fail(endpoint, method.name, new InvalidResponse(), cause))
          )
        ),
        Effect.map((reply) => reply.result),
        (request) => recordRequestMetrics(endpoint, method.name, request)
      )
    }).pipe(
      Effect.withSpan(`${options.spanPrefix}.${method.name}`, {
        attributes: { network, endpoint: endpoint.name, method: method.name }
      })
    )

  // a mismatch is kept, a failed check is not: the next call checks again
  const checkNetwork = (endpoint: Endpoint) =>
    SynchronizedRef.modifyEffect(endpoint.networkCheck, (state) =>
      Option.isSome(state)
        ? Effect.succeed([state.value, state] as const)
        : options.checkNetwork((method, params) => send(endpoint, method, params), endpoint.name).pipe(
          Effect.result,
          Effect.flatMap((checked) =>
            Result.isFailure(checked) && checked.failure.reason._tag !== "WrongNetwork"
              ? Effect.fail(checked.failure)
              : Effect.succeed([checked, Option.some(checked)] as const)
          )
        )).pipe(Effect.flatMap(Effect.fromResult))

  const call = <Params, A>(endpoint: Endpoint, method: Method<Params, A, J>, params: Params) =>
    checkNetwork(endpoint).pipe(Effect.andThen(send(endpoint, method, params)))

  const withFallback = <A>(f: (endpoint: Endpoint) => Effect.Effect<A, E>): Effect.Effect<A, E> => {
    const from = (index: number, errors: ReadonlyArray<E>): Effect.Effect<A, E> =>
      Effect.catch(Effect.suspend(() => f(endpoints[index])), (last) => {
        const tried = [...errors, last]
        if (last.reason._tag !== "WrongNetwork" && index + 1 < endpoints.length) {
          const attributes = { network, endpoint: last.endpoint, method: last.method, outcome: last.reason._tag }
          return Metric.update(Metric.withAttributes(fallbacksMetric, attributes), 1).pipe(
            Effect.andThen(from(index + 1, tried))
          )
        }
        return Effect.fail(
          tried.length === 1 ? last : makeError({
            reason: last.reason,
            method: last.method,
            endpoint: last.endpoint,
            code: last.code,
            cause: new AggregateError(tried, `${tried.length} endpoints failed`)
          })
        )
      })
    return from(0, [])
  }

  const endpointOf = (method: string, cursor: { readonly endpoint: string }): Effect.Effect<Endpoint, E> => {
    const endpoint = endpoints.find((endpoint) => endpoint.name === cursor.endpoint)
    return endpoint === undefined
      ? Effect.fail(makeError({
        reason: new Rejected(),
        method,
        endpoint: cursor.endpoint,
        cause: new Error(`no endpoint named ${cursor.endpoint}`)
      }))
      : Effect.succeed(endpoint)
  }

  const guard = Effect.fnUntraced(function*(
    endpoint: Endpoint,
    method: string,
    toBlock: bigint,
    latest: Effect.Effect<bigint, E>
  ): Effect.fn.Return<void, E> {
    if ((yield* Ref.get(endpoint.head)) >= toBlock) return
    const head = yield* latest
    yield* Ref.update(endpoint.head, BigInt_.max(head))
    if (head < toBlock) {
      return yield* Effect.fail(
        fail(endpoint, method, new Lagging({ head, toBlock }), new Error(`head ${head} is below toBlock ${toBlock}`))
      )
    }
  })

  return { fail, checkNetwork, call, withFallback, endpointOf, guard }
})
