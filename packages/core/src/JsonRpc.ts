/**
 * The JSON-RPC engine shared by the chain RPC modules: an ordered list of endpoints with fallback, sending one request
 * per HTTP call through the provided `HttpClient`.
 *
 * Every call starts at the first endpoint. A failure that another endpoint could answer (`Unavailable`,
 * `InvalidResponse`, `Lagging`, `Pruned`) moves to the next endpoint, `Rejected` and `WrongNetwork` stop at once.
 * Before its first call, each endpoint is checked to serve the configured network, once: a mismatch is kept, a failed
 * check is not.
 *
 * Each chain keeps its own error class, code table, network check, methods and their checks; the engine only builds
 * errors through `makeError`.
 *
 * @since 0.1.0
 */
import type * as Arr from "effect/Array"
import * as BigInt_ from "effect/BigInt"
import * as Data from "effect/Data"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import { constTrue } from "effect/Function"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientError from "effect/http/HttpClientError"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import type * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as SynchronizedRef from "effect/SynchronizedRef"

/**
 * Why a call failed:
 *
 * | reason | meaning | falls back to the next endpoint |
 * |---|---|---|
 * | `Unavailable` | transport, attempt timeout, HTTP error status or an `Unavailable` JSON-RPC code, after the retries | yes |
 * | `InvalidResponse` | the reply is not JSON or fails its schema | yes |
 * | `Lagging` | the endpoint is behind the requested block | yes |
 * | `Pruned` | the endpoint lacks the requested history | yes |
 * | `Rejected` | any other JSON-RPC error, or params that do not encode: every endpoint would answer the same | no |
 * | `WrongNetwork` | the endpoint does not serve the configured network | no |
 *
 * @since 0.1.0
 * @category models
 */
export const Reason = Schema.Literals([
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
export type Reason = typeof Reason.Type

/**
 * What `makeError` receives. `cause` never contains the endpoint URL.
 *
 * @since 0.1.0
 * @category models
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
 */
export type Send<E, J = Schema.Json> = <Params, A>(method: Method<Params, A, J>, params: Params) => Effect.Effect<A, E>

/**
 * - `spanPrefix` names the spans: `${spanPrefix}.${method}`.
 * - `timeout` bounds each attempt, default 30 seconds. A timed-out attempt is not retried: the call moves to the next
 *   endpoint at once.
 * - `retries` is the number of retries per endpoint before falling back, default 3. Transport errors, HTTP
 *   408/429/500/502/503/504 and the `Unavailable` codes are retried with an exponential backoff from `retryDelay`
 *   (default 500 millis) with jitter, honoring `Retry-After`. Any other HTTP status is not retried.
 * - `codes` maps JSON-RPC error codes to a reason, any other code is `Rejected`.
 * - `parseBody` parses a reply body, default `JSON.parse` (an empty body is `null`).
 * - `checkNetwork` asks `endpoint` for its network and fails `WrongNetwork` on a mismatch.
 * - `makeError` builds the chain's error. `E` is inferred from it alone, so annotate its parameter:
 *   `(fields: JsonRpc.ErrorFields) => new ChainRpcError(fields)`.
 *
 * @since 0.1.0
 * @category models
 */
export interface Options<Info, E, J = Schema.Json> {
  readonly spanPrefix: string
  readonly network: string
  readonly endpoints: Arr.NonEmptyReadonlyArray<EndpointConfig>
  readonly timeout?: Duration.Input | undefined
  readonly retries?: number | undefined
  readonly retryDelay?: Duration.Input | undefined
  readonly codes: ReadonlyMap<number, Reason>
  readonly parseBody?: ((text: string) => J) | undefined
  readonly checkNetwork: (send: Send<NoInfer<E>, J>, endpoint: string) => Effect.Effect<Info, NoInfer<E>>
  readonly makeError: (fields: ErrorFields) => E
}

/**
 * @since 0.1.0
 * @category models
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

const fallbackReasons: ReadonlySet<Reason> = new Set(["Unavailable", "InvalidResponse", "Lagging", "Pruned"])

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

// HttpClientError messages and causes can carry the request URL: keep the reason and status only
const withoutUrl = (error: SendError): Error =>
  HttpClientError.isHttpClientError(error)
    ? new Error(`${error.reason._tag}${error.response === undefined ? "" : ` ${error.response.status}`}`)
    : error

/**
 * Builds the engine over `options.endpoints`, tried in order.
 *
 * @since 0.1.0
 * @category constructors
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

  const classify = (error: SendError): { readonly reason: Reason; readonly code?: number | undefined } => {
    if (error instanceof JsonRpcError) return { reason: codes.get(error.code) ?? "Rejected", code: error.code }
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

  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.filterStatusOk,
    // a JSON-RPC error comes with HTTP 200: lift it into the error channel so that it can be retried
    HttpClient.transformResponse((response) =>
      response.pipe(
        Effect.tap((response) =>
          Effect.flatMap(bodyOf(response), (json) =>
            Option.match(Schema.decodeUnknownOption(ErrorReply)(json), {
              onNone: () => Effect.void,
              onSome: ({ error }) => Effect.fail(new JsonRpcError({ code: Number(error.code), message: error.message }))
            }))
        ),
        Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.fail(new AttemptTimeout({ timeout })) })
      )
    ),
    HttpClient.retryTransient({
      retryOn: "errors-only",
      // the `Unavailable` codes: the endpoint is struggling, retry then fall back
      while: (error) => error instanceof JsonRpcError && codes.get(error.code) === "Unavailable",
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

  const send = <Params, A>(endpoint: Endpoint, method: Method<Params, A, J>, params: Params) =>
    Effect.gen(function*() {
      const encoded = yield* Schema.encodeEffect(method.params)(params).pipe(
        Effect.mapError((cause) => fail(endpoint, method.name, "Rejected", cause))
      )
      // one request per HTTP call: the id is never matched
      const json = yield* HttpClientRequest.post(Redacted.value(endpoint.url)).pipe(
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
        Effect.provideService(HttpClient.TracerDisabledWhen, constTrue)
      )
      const reply = yield* Schema.decodeUnknownEffect(Schema.Struct({ result: method.result }))(json).pipe(
        Effect.mapError((cause) => fail(endpoint, method.name, "InvalidResponse", cause))
      )
      return reply.result
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
            Result.isFailure(checked) && checked.failure.reason !== "WrongNetwork"
              ? Effect.fail(checked.failure)
              : Effect.succeed([checked, Option.some(checked)] as const)
          )
        )).pipe(Effect.flatMap(Effect.fromResult))

  const call = <Params, A>(endpoint: Endpoint, method: Method<Params, A, J>, params: Params) =>
    checkNetwork(endpoint).pipe(Effect.andThen(send(endpoint, method, params)))

  const withFallback = Effect.fnUntraced(function*<A>(
    f: (endpoint: Endpoint) => Effect.Effect<A, E>
  ): Effect.fn.Return<A, E> {
    const errors: Array<E> = []
    for (const endpoint of endpoints) {
      const result = yield* Effect.result(f(endpoint))
      if (Result.isSuccess(result)) return result.success
      errors.push(result.failure)
      if (!fallbackReasons.has(result.failure.reason)) break
    }
    const last = errors[errors.length - 1]
    if (errors.length === 1) return yield* Effect.fail(last)
    return yield* Effect.fail(makeError({
      reason: last.reason,
      method: last.method,
      endpoint: last.endpoint,
      code: last.code,
      cause: new AggregateError(errors, `${errors.length} endpoints failed`)
    }))
  })

  const endpointOf = (method: string, cursor: { readonly endpoint: string }): Effect.Effect<Endpoint, E> => {
    const endpoint = endpoints.find((endpoint) => endpoint.name === cursor.endpoint)
    return endpoint === undefined
      ? Effect.fail(makeError({
        reason: "Rejected",
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
        fail(endpoint, method, "Lagging", new Error(`head ${head} is below toBlock ${toBlock}`))
      )
    }
  })

  return { fail, checkNetwork, call, withFallback, endpointOf, guard }
})
