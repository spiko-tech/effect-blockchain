/**
 * Typed, read-only standard Stellar RPC methods, served by an ordered list of endpoints with fallback.
 *
 * Every call starts at the first endpoint. An endpoint failure that another endpoint could answer (see
 * {@link StellarRpcError}) moves to the next endpoint, any other failure stops at once. Before its first call, each
 * endpoint is checked to serve the configured network (`getNetwork` passphrase), once. A `getEvents` call with a
 * cursor only goes to the endpoint that issued the cursor, with no fallback.
 *
 * Every method is a read and safe to repeat, which is what makes the fallback and the HTTP retries sound. A future
 * write method (e.g. `sendTransaction`) must take a transaction signed outside this module, resend the same signed
 * bytes on fallback, never retry blindly after an unclear failure and confirm the outcome by transaction hash.
 *
 * Adding a method takes three steps:
 * 1. define it once in `internal/rpcMethods.ts`: its RPC name, a params codec and a result codec,
 * 2. add one line to the {@link StellarRpc} service and its layer, calling it through the shared `call`, which does
 *    the network check, the request, the error classification, the decoding and the span,
 * 3. add one test decoding a fake response.
 *
 * Methods are named after the RPC method.
 *
 * @since 0.1.0
 */
import * as Arr from "effect/Array"
import * as Brand from "effect/Brand"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import { constTrue } from "effect/Function"
import * as HttpClient from "effect/http/HttpClient"
import type * as HttpClientError from "effect/http/HttpClientError"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as Layer from "effect/Layer"
import * as Order from "effect/Order"
import * as Redacted from "effect/Redacted"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as SynchronizedRef from "effect/SynchronizedRef"
import * as RpcMethods from "./internal/rpcMethods.ts"
import type { StellarContractAddress } from "./StellarAddress.ts"
import type { StellarContractEvent } from "./StellarContractEvent.ts"
import * as StellarNetwork from "./StellarNetwork.ts"

/**
 * A Stellar RPC endpoint. The `name` is shown in errors and spans and routes cursors, so it must be unique; the `url`
 * is never logged.
 *
 * @since 0.1.0
 * @category models
 */
export interface StellarRpcEndpoint {
  readonly name: string
  readonly url: Redacted.Redacted<string>
}

/**
 * Why a call failed:
 *
 * | reason | meaning | falls back to the next endpoint |
 * |---|---|---|
 * | `Unavailable` | transport, timeout, HTTP error status, JSON-RPC internal error `-32603`, after the HTTP retries | yes |
 * | `InvalidResponse` | the body is not a JSON-RPC reply, the result fails its schema, or an event fails the `getEvents` checks | yes |
 * | `Lagging` | the endpoint's latest ledger is below the requested `toBlock` | yes |
 * | `Pruned` | the endpoint's oldest retained ledger is above the requested `fromBlock` (or cursor) | yes |
 * | `Rejected` | any other JSON-RPC error: every endpoint would answer the same | no |
 * | `WrongNetwork` | the endpoint's `getNetwork` passphrase is not the configured network's | no |
 *
 * A call with a cursor never falls back, whatever the reason.
 *
 * @since 0.1.0
 * @category models
 */
export const StellarRpcErrorReason = Schema.Literals([
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
export type StellarRpcErrorReason = typeof StellarRpcErrorReason.Type

/**
 * A failed call. `code` is the JSON-RPC error code or the HTTP status when there is one, and `cause` never contains
 * the endpoint URL. When several endpoints were tried, the error is the last one and its `cause` is an
 * `AggregateError` of every endpoint's error, in order.
 *
 * @since 0.1.0
 * @category errors
 */
export class StellarRpcError extends Schema.TaggedError<StellarRpcError>()("StellarRpcError", {
  reason: StellarRpcErrorReason,
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
 * Where a `getEvents` page stopped: the RPC paging cursor and the endpoint that issued it. Opaque: only pass it back to
 * `getEvents` with the same filter.
 *
 * @since 0.1.0
 * @category models
 */
export type StellarEventsCursor = Brand.Branded<{
  readonly endpoint: string
  readonly cursor: string
}, "StellarEventsCursor">

const StellarEventsCursor = Brand.nominal<StellarEventsCursor>()

/**
 * A `getEvents` filter over the inclusive ledger range `[fromBlock, toBlock]`.
 *
 * - `contractIds`: 1 to 5 contracts (the RPC limit).
 * - `topics`: RPC topic filters, each a list of 1 to 4 segments: a base64 XDR `ScVal`, `"*"` (any one topic) or a
 *   final `"**"` (any number of topics). An event matches when it matches any filter.
 * - `limit`: page size, default 1000, at most 10000.
 * - `cursor`: the cursor of the previous page, to continue from it on the same endpoint.
 *
 * @since 0.1.0
 * @category models
 */
export interface StellarEventsFilter {
  readonly contractIds: Arr.NonEmptyReadonlyArray<StellarContractAddress>
  readonly fromBlock: bigint
  readonly toBlock: bigint
  readonly topics?: ReadonlyArray<ReadonlyArray<string>> | undefined
  readonly limit?: number | undefined
  readonly cursor?: StellarEventsCursor | undefined
}

/**
 * One `getEvents` page, sorted by event id. `cursor` is `undefined` once the range is done.
 *
 * @since 0.1.0
 * @category models
 */
export interface StellarEventsPage {
  readonly events: ReadonlyArray<StellarContractEvent>
  readonly cursor: StellarEventsCursor | undefined
}

/**
 * @since 0.1.0
 * @category models
 */
export interface StellarNetworkInfo {
  readonly passphrase: string
  readonly protocolVersion: number
}

/**
 * @since 0.1.0
 * @category models
 */
export interface StellarLatestLedger {
  readonly sequence: bigint
  /** Hex hash of the ledger. */
  readonly id: string
  readonly protocolVersion: number
}

/**
 * @since 0.1.0
 * @category services
 */
export class StellarRpc extends Context.Service<StellarRpc, {
  readonly network: StellarNetwork.StellarNetwork
  /**
   * `getNetwork`, verified against `network` once per endpoint then served from that check: `protocolVersion` is the
   * one seen at the check, `getLatestLedger` has the current one.
   */
  readonly getNetwork: Effect.Effect<StellarNetworkInfo, StellarRpcError>
  /** `getLatestLedger` */
  readonly getLatestLedger: Effect.Effect<StellarLatestLedger, StellarRpcError>
  /**
   * `getEvents` for contract events, one page. Without a cursor, only answered by an endpoint whose latest ledger has
   * reached `toBlock` and that still retains `fromBlock`. Events above `toBlock` are dropped. An event of another
   * type, of another contract or below `fromBlock` fails with `InvalidResponse`. An empty range returns no events and
   * no cursor.
   *
   * The range is done (`cursor: undefined`) when the RPC cursor is past `toBlock`. The RPC cursor is the last event's
   * id when the page is full, otherwise the end of the scanned ledgers (the RPC scans at most 10000 ledgers per
   * request), so a short page is not enough: the range is done when the cursor's ledger is above `toBlock`, or equals
   * it on a page that is not full. A short page ending at the endpoint's latest ledger below `toBlock` fails with
   * `Lagging`.
   */
  readonly getEvents: (filter: StellarEventsFilter) => Effect.Effect<StellarEventsPage, StellarRpcError>
}>()("@effect-blockchain/stellar/StellarRpc") {}

const fallbackReasons: ReadonlySet<StellarRpcErrorReason> = new Set([
  "Unavailable",
  "InvalidResponse",
  "Lagging",
  "Pruned"
])

// JSON-RPC internal error: stellar-rpc returns it for its own database or I/O failures
const unavailableCodes: ReadonlySet<number> = new Set([-32603])

// stellar-rpc's out-of-range start, current ("startLedger must be within the ledger range: X - Y") and older
// ("startLedger must be between the oldest ledger: X and the latest ledger: Y ...")
const ledgerRangeError = /startLedger must be \D*(\d+)\D+(\d+)/u

const JsonRpcReply = Schema.Union([
  Schema.Struct({ error: Schema.Struct({ code: Schema.Number, message: Schema.String }) }),
  Schema.Struct({ result: Schema.Json })
])

// the ledger of a TOID cursor: ledger << 32 | transaction << 12 | operation
const cursorLedger = (cursor: string) => BigInt(cursor.slice(0, 19)) >> BigInt(32)

const byId = Order.mapInput(Order.String, (event: StellarContractEvent) => event.id)

type NetworkCheck = "Unchecked" | StellarNetworkInfo | StellarRpcError

/**
 * Builds a {@link StellarRpc} over `endpoints`, tried in order, sending requests with the provided `HttpClient`.
 *
 * - `timeout` bounds each attempt, default 30 seconds.
 * - `retries` is the number of HTTP retries per endpoint before falling back, default 3. `HttpClient.retryTransient`
 *   retries timeouts, transport errors and HTTP 408/429/500/502/503/504 with an exponential backoff from `retryDelay`
 *   (default 500 millis) with jitter, honoring `Retry-After`.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer = (options: {
  readonly network: StellarNetwork.StellarNetwork
  readonly endpoints: Arr.NonEmptyReadonlyArray<StellarRpcEndpoint>
  readonly timeout?: Duration.Input | undefined
  readonly retries?: number | undefined
  readonly retryDelay?: Duration.Input | undefined
}): Layer.Layer<StellarRpc, never, HttpClient.HttpClient> =>
  Layer.effect(
    StellarRpc,
    Effect.gen(function*() {
      const { network } = options
      const passphrase = StellarNetwork.toPassphrase(network)
      const timeout = Duration.fromInputUnsafe(options.timeout ?? Duration.seconds(30))
      const client = (yield* HttpClient.HttpClient).pipe(
        HttpClient.filterStatusOk,
        HttpClient.transformResponse(Effect.timeout(timeout)),
        HttpClient.retryTransient({
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

      const fail = (endpoint: Endpoint, method: string, reason: StellarRpcErrorReason, cause: Error) =>
        new StellarRpcError({ reason, method, endpoint: endpoint.name, cause })

      // HttpClient errors carry the request, hence the URL: keep only a description of what failed
      // shortcut: a transport error loses its underlying cause (e.g. ECONNREFUSED), redact it if that is ever needed
      const httpError = (
        endpoint: Endpoint,
        method: string,
        error: HttpClientError.HttpClientError | Cause.TimeoutError
      ) => {
        if (Cause.isTimeoutError(error)) {
          return fail(endpoint, method, "Unavailable", new Error(`timed out after ${Duration.format(timeout)}`))
        }
        const { reason } = error
        if (reason._tag === "DecodeError" || reason._tag === "EmptyBodyError") {
          return fail(endpoint, method, "InvalidResponse", new Error(`${reason._tag}: the body is not JSON`))
        }
        const status = error.response?.status
        return new StellarRpcError({
          reason: "Unavailable",
          method,
          endpoint: endpoint.name,
          code: status,
          cause: new Error(status === undefined ? reason._tag : `HTTP ${status}`)
        })
      }

      const send = <Params, A>(endpoint: Endpoint, method: RpcMethods.RpcMethod<Params, A>, params: Params) =>
        Effect.gen(function*() {
          const encoded = yield* Schema.encodeEffect(method.params)(params).pipe(
            Effect.mapError((cause) => fail(endpoint, method.name, "Rejected", cause))
          )
          const body = yield* HttpClientRequest.post(endpoint.url).pipe(
            HttpClientRequest.bodyJsonUnsafe({
              jsonrpc: "2.0",
              id: 1,
              method: method.name,
              ...(encoded === undefined ? {} : { params: encoded })
            }),
            client.execute,
            Effect.flatMap((response) => response.json),
            // the client span would record the URL: this module's span replaces it
            Effect.provideService(HttpClient.TracerDisabledWhen, constTrue),
            Effect.mapError((error) => httpError(endpoint, method.name, error))
          )
          const reply = yield* Schema.decodeUnknownEffect(JsonRpcReply)(body).pipe(
            Effect.mapError((cause) => fail(endpoint, method.name, "InvalidResponse", cause))
          )
          if ("error" in reply) {
            const { code, message } = reply.error
            return yield* new StellarRpcError({
              reason: unavailableCodes.has(code) ? "Unavailable" : "Rejected",
              method: method.name,
              endpoint: endpoint.name,
              code,
              cause: new Error(message)
            })
          }
          return yield* Schema.decodeEffect(method.result)(reply.result).pipe(
            Effect.mapError((cause) => fail(endpoint, method.name, "InvalidResponse", cause))
          )
        }).pipe(
          Effect.withSpan(`StellarRpc.${method.name}`, {
            attributes: { network, endpoint: endpoint.name, method: method.name }
          })
        )

      // a mismatch is kept, a failed check is not: the next call checks again
      const checkNetwork = (endpoint: Endpoint) =>
        SynchronizedRef.modifyEffect(endpoint.networkCheck, (state) =>
          state !== "Unchecked"
            ? Effect.succeed([state, state] as const)
            : send(endpoint, RpcMethods.getNetwork, undefined).pipe(
              Effect.map((info): StellarNetworkInfo | StellarRpcError =>
                info.passphrase === passphrase ?
                  info :
                  fail(
                    endpoint,
                    RpcMethods.getNetwork.name,
                    "WrongNetwork",
                    new Error(`expected passphrase "${passphrase}" for ${network}, got "${info.passphrase}"`)
                  )
              ),
              Effect.map((checked) => [checked, checked] as const)
            )).pipe(
            Effect.flatMap((state) => state instanceof StellarRpcError ? Effect.fail(state) : Effect.succeed(state))
          )

      const call = <Params, A>(endpoint: Endpoint, method: RpcMethods.RpcMethod<Params, A>, params: Params) =>
        checkNetwork(endpoint).pipe(Effect.andThen(send(endpoint, method, params)))

      const withFallback = Effect.fnUntraced(function*<A>(
        f: (endpoint: Endpoint) => Effect.Effect<A, StellarRpcError>
      ): Effect.fn.Return<A, StellarRpcError> {
        const errors: Array<StellarRpcError> = []
        for (const endpoint of endpoints) {
          const result = yield* Effect.result(f(endpoint))
          if (Result.isSuccess(result)) return result.success
          errors.push(result.failure)
          if (!fallbackReasons.has(result.failure.reason)) break
        }
        const last = errors[errors.length - 1]
        if (errors.length === 1) return yield* last
        return yield* new StellarRpcError({
          reason: last.reason,
          method: last.method,
          endpoint: last.endpoint,
          code: last.code,
          cause: new AggregateError(errors, `${errors.length} endpoints failed`)
        })
      })

      const seeHead = (endpoint: Endpoint, head: bigint) =>
        Ref.update(endpoint.head, (known) => head > known ? head : known)

      // retention is not cached (the oldest ledger moves): getHealth checks it when the head is checked, the RPC
      // checks it on every getEvents call and its out-of-range error is mapped back to Pruned or Lagging
      const guard = Effect.fnUntraced(function*(endpoint: Endpoint, fromBlock: bigint, toBlock: bigint) {
        if ((yield* Ref.get(endpoint.head)) >= toBlock) return
        const health = yield* call(endpoint, RpcMethods.getHealth, undefined)
        yield* seeHead(endpoint, health.latestLedger)
        const method = RpcMethods.getEvents.name
        if (health.latestLedger < toBlock) {
          return yield* fail(
            endpoint,
            method,
            "Lagging",
            new Error(`latest ledger ${health.latestLedger} is below toBlock ${toBlock}`)
          )
        }
        if (health.oldestLedger > fromBlock) {
          return yield* fail(
            endpoint,
            method,
            "Pruned",
            new Error(`oldest ledger ${health.oldestLedger} is above fromBlock ${fromBlock}`)
          )
        }
      })

      const outOfRange = (error: StellarRpcError, start: bigint): StellarRpcError => {
        const match = error.reason === "Rejected" && error.cause instanceof Error
          ? ledgerRangeError.exec(error.cause.message)
          : null
        if (match === null) return error
        return new StellarRpcError({
          reason: start < BigInt(match[1]) ? "Pruned" : "Lagging",
          method: error.method,
          endpoint: error.endpoint,
          code: error.code,
          cause: error.cause
        })
      }

      const getEventsOn = Effect.fnUntraced(function*(endpoint: Endpoint, filter: StellarEventsFilter) {
        const { cursor, fromBlock, toBlock } = filter
        const method = RpcMethods.getEvents.name
        const limit = filter.limit ?? 1000
        if (cursor === undefined) yield* guard(endpoint, fromBlock, toBlock)
        const page = yield* call(endpoint, RpcMethods.getEvents, {
          ...(cursor === undefined ? { startLedger: fromBlock, endLedger: toBlock + BigInt(1) } : {}),
          filters: [{
            type: "contract",
            contractIds: filter.contractIds,
            ...(filter.topics === undefined ? {} : { topics: filter.topics })
          }],
          pagination: { limit, ...(cursor === undefined ? {} : { cursor: cursor.cursor }) }
        }).pipe(
          Effect.mapError((error) => outOfRange(error, cursor === undefined ? fromBlock : cursorLedger(cursor.cursor)))
        )
        yield* seeHead(endpoint, page.latestLedger)

        const contracts = new Set<string>(filter.contractIds)
        const invalid = page.events.find((event) =>
          event.type !== "contract" || !contracts.has(event.contractId) || event.blockNumber < fromBlock
        )
        if (invalid !== undefined) {
          return yield* fail(
            endpoint,
            method,
            "InvalidResponse",
            new Error(`event ${invalid.id} is outside the filter`)
          )
        }

        const last = cursorLedger(page.cursor)
        const full = page.events.length >= limit
        if (!full && last < toBlock && last >= page.latestLedger) {
          return yield* fail(
            endpoint,
            method,
            "Lagging",
            new Error(`latest ledger ${page.latestLedger} is below toBlock ${toBlock}`)
          )
        }
        const done = last > toBlock || (!full && last === toBlock)
        return {
          events: Arr.sort(page.events.filter((event) => event.blockNumber <= toBlock), byId),
          cursor: done ? undefined : StellarEventsCursor({ endpoint: endpoint.name, cursor: page.cursor })
        }
      })

      return StellarRpc.of({
        network,
        getNetwork: withFallback(checkNetwork),
        getLatestLedger: withFallback((endpoint) =>
          call(endpoint, RpcMethods.getLatestLedger, undefined).pipe(
            Effect.tap((ledger) => seeHead(endpoint, ledger.sequence))
          )
        ),
        getEvents: (filter) => {
          const { cursor } = filter
          if (cursor === undefined) {
            return filter.fromBlock > filter.toBlock
              ? Effect.succeed({ events: [], cursor: undefined })
              : withFallback((endpoint) => getEventsOn(endpoint, filter))
          }
          // a cursor is only valid on the endpoint that issued it
          const endpoint = endpoints.find((endpoint) => endpoint.name === cursor.endpoint)
          return endpoint === undefined
            ? Effect.fail(
              new StellarRpcError({
                reason: "Rejected",
                method: RpcMethods.getEvents.name,
                endpoint: cursor.endpoint,
                cause: new Error(`no endpoint named ${cursor.endpoint}`)
              })
            )
            : getEventsOn(endpoint, filter)
        }
      })
    })
  )
