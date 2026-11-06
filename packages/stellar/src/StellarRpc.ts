/**
 * Typed, read-only Stellar RPC methods over an ordered list of endpoints with fallback.
 *
 * A call starts at the first endpoint and moves to the next one on failure, except on `WrongNetwork`. Each endpoint
 * is checked once to serve the configured network (`getNetwork` passphrase). Every method is a read, so retries and
 * fallback are safe. Methods are named after the RPC method. A `getEvents` page cursor is only sent to the endpoint
 * that issued it, with no fallback.
 *
 * @example
 * ```ts
 * import type { StellarContractAddress } from "@effect-blockchain/stellar/StellarAddress"
 * import * as StellarRpc from "@effect-blockchain/stellar/StellarRpc"
 * import * as Effect from "effect/Effect"
 *
 * declare const contract: StellarContractAddress
 *
 * // the first page of events of `contract` over the last 100 ledgers
 * const recent = Effect.gen(function*() {
 *   const rpc = yield* StellarRpc.StellarRpc
 *   const { sequence } = yield* rpc.getLatestLedger
 *   return yield* rpc.getEvents({ contractIds: [contract], fromBlock: sequence - BigInt(100), toBlock: sequence })
 * })
 * ```
 *
 * @since 0.1.0
 */
import * as JsonRpc from "@effect-blockchain/core/JsonRpc"
import * as Arr from "effect/Array"
import * as BigInt_ from "effect/BigInt"
import * as Config from "effect/Config"
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
 * A failed call: its `reason` (a {@link JsonRpc.Reason}, matched with `Effect.catchReason`), the JSON-RPC error code or
 * HTTP status as `code`, and a `cause` without the endpoint URL. After several endpoints, the error is the last one
 * and `cause` is an `AggregateError` of each endpoint's error, in order.
 *
 * On Stellar, `Unavailable` includes the code -32603, `InvalidResponse` an event outside the `getEvents` filter,
 * `Lagging` a latest ledger below `toBlock`, and `Pruned` an oldest retained ledger above `fromBlock` (or the cursor).
 *
 * @since 0.1.0
 * @category errors
 */
export class StellarRpcError extends Schema.TaggedError<StellarRpcError>()("StellarRpcError", {
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
   * `getEvents` for contract events, one page in chain order (by event id), only answered by an endpoint whose latest
   * ledger has reached `toBlock` and that still retains `fromBlock`. Events above `toBlock` are dropped, and an event of
   * another type, of another contract or below `fromBlock` fails with `InvalidResponse`.
   *
   * `cursor` is `undefined` once the RPC cursor passes `toBlock`. A short page is not the end of the range: the RPC
   * scans at most 10000 ledgers per request. A short page stopping at a latest ledger below `toBlock` fails `Lagging`.
   */
  readonly getEvents: (filter: StellarEventsFilter) => Effect.Effect<StellarEventsPage, StellarRpcError>
}>()("@effect-blockchain/stellar/StellarRpc") {}

// JSON-RPC internal error: stellar-rpc returns it for its own database or I/O failures, retry then fall back
const codes: ReadonlyMap<number, JsonRpc.CodeReason> = new Map([[-32603, "Unavailable"]])

// stellar-rpc's out-of-range start, current ("startLedger must be within the ledger range: X - Y") and older
// ("startLedger must be between the oldest ledger: X and the latest ledger: Y ...")
const ledgerRangeError = /startLedger must be \D*(\d+)\D+(\d+)/u

// the ledger of a TOID cursor: ledger << 32 | transaction << 12 | operation
const cursorLedger = (cursor: string) => BigInt(cursor.slice(0, 19)) >> BigInt(32)

const byId = Order.mapInput(Order.String, (event: StellarContractEvent) => event.id)

type Endpoint = JsonRpc.Endpoint<StellarNetworkInfo, StellarRpcError>

/**
 * Builds a {@link StellarRpc} over `endpoints`, tried in order, sending requests with the provided `HttpClient`
 * (e.g. `FetchHttpClient.layer`). `timeout` (default 30 seconds) bounds each attempt, `retries` (default 3) and
 * `retryDelay` (default 500 millis) set the backoff before falling back: see {@link JsonRpc.Unavailable}.
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
                  reason: new JsonRpc.WrongNetwork({ expected: passphrase, actual: info.passphrase }),
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

      // retention is not cached (the oldest ledger moves): getHealth checks it with the head, and the RPC's own
      // out-of-range error on getEvents is mapped back to Pruned or Lagging
      const guard = Effect.fnUntraced(function*(endpoint: Endpoint, fromBlock: bigint, toBlock: bigint) {
        if ((yield* Ref.get(endpoint.head)) >= toBlock) return
        const health = yield* call(endpoint, RpcMethods.getHealth, undefined)
        yield* Ref.update(endpoint.head, BigInt_.max(health.latestLedger))
        const method = RpcMethods.getEvents.name
        if (health.latestLedger < toBlock) {
          return yield* fail(
            endpoint,
            method,
            new JsonRpc.Lagging({ head: health.latestLedger, toBlock }),
            new Error(`latest ledger ${health.latestLedger} is below toBlock ${toBlock}`)
          )
        }
        if (health.oldestLedger > fromBlock) {
          return yield* fail(
            endpoint,
            method,
            new JsonRpc.Pruned(),
            new Error(`oldest ledger ${health.oldestLedger} is above fromBlock ${fromBlock}`)
          )
        }
      })

      // `start` is lazy: a cursor that failed to encode is not a TOID
      const outOfRange = (error: StellarRpcError, start: () => bigint): StellarRpcError => {
        const match = error.reason._tag === "Rejected" && error.cause instanceof Error
          ? ledgerRangeError.exec(error.cause.message)
          : null
        if (match === null) return error
        return new StellarRpcError({
          reason: start() < BigInt(match[1])
            ? new JsonRpc.Pruned()
            : new JsonRpc.Lagging({ head: BigInt(match[2]), toBlock: start() }),
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
            new JsonRpc.InvalidResponse(),
            new Error(`event ${invalid.id} is outside the filter`)
          )
        }

        const last = cursorLedger(page.cursor)
        const full = page.events.length >= limit
        if (!full && last < toBlock && last >= page.latestLedger) {
          return yield* fail(
            endpoint,
            method,
            new JsonRpc.Lagging({ head: page.latestLedger, toBlock }),
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

/**
 * Builds an {@link StellarRpc} like {@link layer}, reading the options from `Config`. Endpoint URLs stay `Redacted`.
 *
 * @example
 * ```ts
 * import * as StellarRpc from "@effect-blockchain/stellar/StellarRpc"
 * import * as Config from "effect/Config"
 *
 * const RpcLive = StellarRpc.layerConfig({
 *   network: Config.succeed("Stellar"),
 *   endpoints: Config.all([Config.all({ name: Config.succeed("main"), url: Config.Redacted("STELLAR_RPC_URL") })])
 * })
 * ```
 *
 * @since 0.1.0
 * @category layers
 */
export const layerConfig = (
  options: Config.Wrap<Parameters<typeof layer>[0]>
): Layer.Layer<StellarRpc, Config.ConfigError, HttpClient.HttpClient> =>
  Layer.unwrap(Effect.map(Config.unwrap(options), layer))
