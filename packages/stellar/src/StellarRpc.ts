/**
 * Typed, read-only standard Stellar RPC methods, served by an ordered list of endpoints with fallback.
 *
 * Every call starts at the first endpoint. An endpoint failure (see {@link StellarRpcError}) moves to the next
 * endpoint, except `WrongNetwork`, which stops at once. Before its first call, each
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
import * as JsonRpc from "@effect-blockchain/core/JsonRpc"
import * as Arr from "effect/Array"
import * as BigInt_ from "effect/BigInt"
import * as Context from "effect/Context"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import type * as HttpClient from "effect/http/HttpClient"
import * as Layer from "effect/Layer"
import * as Order from "effect/Order"
import type * as Redacted from "effect/Redacted"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
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
 * | `Unavailable` | transport, HTTP error status, JSON-RPC internal error `-32603`, after the retries, or a timeout (not retried) | yes |
 * | `InvalidResponse` | the body is not a JSON-RPC reply, the result fails its schema, or an event fails the `getEvents` checks | yes |
 * | `Lagging` | the endpoint's latest ledger is below the requested `toBlock` | yes |
 * | `Pruned` | the endpoint's oldest retained ledger is above the requested `fromBlock` (or cursor) | yes |
 * | `Rejected` | any other JSON-RPC error: not retried, but another provider may answer (e.g. a lower block range limit) | yes |
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
 * @category schemas
 */
export const StellarEventsCursor = Schema.Struct({
  endpoint: Schema.String,
  cursor: Schema.String
}).pipe(Schema.brand("StellarEventsCursor"))

/**
 * @since 0.1.0
 * @category models
 */
export type StellarEventsCursor = typeof StellarEventsCursor.Type

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
 * One `getEvents` page, in chain order (sorted by event id). `cursor` is `undefined` once the range is done.
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
   * reached `toBlock` and that still retains `fromBlock`. Events are returned in chain order: sorted by event id, which
   * orders them by ledger, transaction, operation and event index. Events above `toBlock` are dropped. An event of
   * another type, of another contract or below `fromBlock` fails with `InvalidResponse`. An empty range returns no
   * events and no cursor.
   *
   * The range is done (`cursor: undefined`) when the RPC cursor is past `toBlock`. The RPC cursor is the last event's
   * id when the page is full, otherwise the end of the scanned ledgers (the RPC scans at most 10000 ledgers per
   * request), so a short page is not enough: the range is done when the cursor's ledger is above `toBlock`, or equals
   * it on a page that is not full. A short page ending at the endpoint's latest ledger below `toBlock` fails with
   * `Lagging`.
   */
  readonly getEvents: (filter: StellarEventsFilter) => Effect.Effect<StellarEventsPage, StellarRpcError>
}>()("@effect-blockchain/stellar/StellarRpc") {}

// JSON-RPC internal error: stellar-rpc returns it for its own database or I/O failures, retry then fall back
const codes: ReadonlyMap<number, JsonRpc.Reason> = new Map([[-32603, "Unavailable"]])

// stellar-rpc's out-of-range start, current ("startLedger must be within the ledger range: X - Y") and older
// ("startLedger must be between the oldest ledger: X and the latest ledger: Y ...")
const ledgerRangeError = /startLedger must be \D*(\d+)\D+(\d+)/u

// the ledger of a TOID cursor: ledger << 32 | transaction << 12 | operation
const cursorLedger = (cursor: string) => BigInt(cursor.slice(0, 19)) >> BigInt(32)

const byId = Order.mapInput(Order.String, (event: StellarContractEvent) => event.id)

type Endpoint = JsonRpc.Endpoint<StellarNetworkInfo, StellarRpcError>

/**
 * Builds a {@link StellarRpc} over `endpoints`, tried in order, sending requests with the provided `HttpClient`.
 *
 * - `timeout` bounds each attempt, default 30 seconds. A timed-out attempt is not retried: the call moves to the next
 *   endpoint at once.
 * - `retries` is the number of retries per endpoint before falling back, default 3. Transport errors, HTTP
 *   408/429/500/502/503/504 and the `Unavailable` JSON-RPC codes (`-32603`) are retried with an exponential backoff
 *   from `retryDelay` (default 500 millis) with jitter, honoring `Retry-After`. Any other HTTP status (e.g. 403) is not
 *   retried and falls back at once.
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
      const rpc = yield* JsonRpc.make({
        spanPrefix: "StellarRpc",
        network,
        endpoints: options.endpoints,
        timeout: options.timeout,
        retries: options.retries,
        retryDelay: options.retryDelay,
        codes,
        checkNetwork: (send, endpoint) =>
          send(RpcMethods.getNetwork, undefined).pipe(
            Effect.flatMap((info) =>
              info.passphrase === passphrase ? Effect.succeed(info) : Effect.fail(
                new StellarRpcError({
                  reason: "WrongNetwork",
                  method: RpcMethods.getNetwork.name,
                  endpoint,
                  cause: new Error(`expected passphrase "${passphrase}" for ${network}, got "${info.passphrase}"`)
                })
              )
            )
          ),
        makeError: (fields: JsonRpc.ErrorFields) => new StellarRpcError(fields)
      })
      const { call, fail, withFallback } = rpc

      // every answer that tells a latest ledger raises the endpoint's known head, the guard only asks when it is behind
      // retention is not cached (the oldest ledger moves): getHealth checks it when the head is checked, the RPC
      // checks it on every getEvents call and its out-of-range error is mapped back to Pruned or Lagging
      const guard = Effect.fnUntraced(function*(endpoint: Endpoint, fromBlock: bigint, toBlock: bigint) {
        if ((yield* Ref.get(endpoint.head)) >= toBlock) return
        const health = yield* call(endpoint, RpcMethods.getHealth, undefined)
        yield* Ref.update(endpoint.head, BigInt_.max(health.latestLedger))
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

      // `start` is lazy: a cursor that failed to encode is not a TOID
      const outOfRange = (error: StellarRpcError, start: () => bigint): StellarRpcError => {
        const match = error.reason === "Rejected" && error.cause instanceof Error
          ? ledgerRangeError.exec(error.cause.message)
          : null
        if (match === null) return error
        return new StellarRpcError({
          reason: start() < BigInt(match[1]) ? "Pruned" : "Lagging",
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
          Effect.mapError((error) =>
            outOfRange(error, () => cursor === undefined ? fromBlock : cursorLedger(cursor.cursor))
          )
        )
        yield* Ref.update(endpoint.head, BigInt_.max(page.latestLedger))

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
          cursor: done ? undefined : StellarEventsCursor.make({ endpoint: endpoint.name, cursor: page.cursor })
        }
      })

      return StellarRpc.of({
        network,
        getNetwork: withFallback(rpc.checkNetwork),
        getLatestLedger: withFallback((endpoint) =>
          call(endpoint, RpcMethods.getLatestLedger, undefined).pipe(
            Effect.tap((ledger) => Ref.update(endpoint.head, BigInt_.max(ledger.sequence)))
          )
        ),
        getEvents: (filter) => {
          const { cursor } = filter
          if (filter.fromBlock > filter.toBlock) return Effect.succeed({ events: [], cursor: undefined })
          if (cursor === undefined) return withFallback((endpoint) => getEventsOn(endpoint, filter))
          // a cursor is only valid on the endpoint that issued it
          return rpc.endpointOf(RpcMethods.getEvents.name, cursor).pipe(
            Effect.flatMap((endpoint) => getEventsOn(endpoint, filter))
          )
        }
      })
    })
  )
