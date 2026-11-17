/**
 * Typed Stellar RPC methods over an ordered list of endpoints with fallback.
 *
 * A call starts at the first endpoint and moves to the next one on failure, except on `WrongNetwork`. Each endpoint
 * is checked once to serve the configured network (`getNetwork` passphrase). Every method is a read, except
 * `sendTransaction`, which a node answers `DUPLICATE` the second time: retries and fallback are safe. Methods are
 * named after the RPC method. A `getEvents` or `getLedgers` page cursor is only sent to the endpoint that issued it,
 * with no fallback. An endpoint flagged `archive` serves the whole history: it takes every call like the others, and
 * is the only kind to take a `getLedgers` call asking for `archive`.
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
import { TransactionBuilder } from "@stellar/stellar-sdk"
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
import type { StellarTransactionHash } from "./StellarTransactionHash.ts"

/**
 * A Stellar RPC endpoint. The `name` is shown in errors and spans and routes cursors, so it must be unique; the `url`
 * is never logged. `archive` flags an endpoint that serves ledgers older than the retention window of a regular one.
 *
 * @since 0.1.0
 * @category models
 */
export interface StellarRpcEndpoint {
  readonly name: string
  readonly url: Redacted.Redacted<string>
  readonly archive?: boolean | undefined
}

/**
 * A failed call: its `reason` (a {@link JsonRpc.Reason}, matched with `Effect.catchReason`), the JSON-RPC error code or
 * HTTP status as `code`, and a `cause` without the endpoint URL. After several endpoints, the error is the last one
 * and `cause` is an `AggregateError` of each endpoint's error, in order.
 *
 * On Stellar, `Unavailable` includes the code -32603, `InvalidResponse` an event outside the `getEvents` filter or a
 * `getLedgers` page with a missing ledger, `Lagging` a latest ledger below `toBlock` (or `startLedger`, `minLedger`),
 * `Pruned` an oldest retained ledger above `fromBlock` (or the cursor, `startLedger`), and `Rejected` a `getLedgers`
 * call asking for `archive` when no endpoint is flagged.
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
 * A closed ledger from `getLedgers`: its close time in unix seconds and its `LedgerCloseMeta`, base64 XDR left
 * undecoded (1 to 3 MB per mainnet ledger).
 *
 * @since 0.2.0
 * @category models
 */
export interface StellarLedger {
  readonly sequence: bigint
  readonly closeTime: number
  readonly metadataXdr: string
}

/**
 * Where a `getLedgers` page stopped: the RPC paging cursor and the endpoint that issued it. Opaque: only pass it back to
 * `getLedgers`.
 *
 * @since 0.3.0
 * @category schemas
 */
export const StellarLedgersCursor = Schema.Struct({
  endpoint: Schema.String,
  cursor: Schema.String
}).pipe(Schema.brand("StellarLedgersCursor"))

/**
 * @since 0.3.0
 * @category models
 */
export type StellarLedgersCursor = typeof StellarLedgersCursor.Type

/**
 * Which `getLedgers` page to read: the one starting at `startLedger`, or the one after `cursor`, on the endpoint that
 * issued it.
 *
 * - `limit`: page size, 1 to 200, default 50 (stellar-rpc `max-ledgers-limit` and `default-ledgers-limit`,
 *   https://developers.stellar.org/docs/data/apis/rpc/api-reference/methods/getLedgers).
 * - `archive`: only ask the endpoints flagged `archive`.
 *
 * @since 0.3.0
 * @category models
 */
export type StellarLedgersOptions =
  | {
    readonly startLedger: bigint
    readonly limit?: number | undefined
    readonly archive?: boolean | undefined
  }
  | { readonly cursor: StellarLedgersCursor; readonly limit?: number | undefined }

/**
 * One `getLedgers` page, in order and without a gap, with the ledger range the endpoint retains. An archive endpoint
 * serves ledgers below its `oldestLedger`.
 *
 * @since 0.3.0
 * @category models
 */
export interface StellarLedgersPage {
  readonly ledgers: ReadonlyArray<StellarLedger>
  readonly cursor: StellarLedgersCursor
  readonly latestLedger: bigint
  readonly oldestLedger: bigint
}

/**
 * A ledger entry from `getLedgerEntries`: its base64 `LedgerEntryData` XDR, the last ledger that changed it and, on
 * the nodes that return it, its base64 `LedgerEntryExt` XDR, which holds the account sponsoring its reserve.
 *
 * @since 0.2.0
 * @category models
 */
export interface StellarLedgerEntry {
  readonly xdr: string
  readonly lastModifiedLedger: bigint
  readonly extXdr?: string
}

/**
 * A `getTransaction` reply, with the ledger range the endpoint holds transactions for. A transaction in a ledger has
 * its `ledger`, its close time `createdAt` in unix seconds, its `applicationOrder` in the ledger and its envelope,
 * result and meta as base64 XDR, left undecoded. `FAILED` is in a ledger too: its operations had no effect.
 *
 * @since 0.2.0
 * @category models
 */
export type StellarTransactionInfo =
  | { readonly status: "NOT_FOUND"; readonly latestLedger: bigint; readonly oldestLedger: bigint }
  | {
    readonly status: "SUCCESS" | "FAILED"
    readonly latestLedger: bigint
    readonly oldestLedger: bigint
    readonly ledger: bigint
    readonly createdAt: number
    readonly applicationOrder: number
    readonly feeBump: boolean
    readonly envelopeXdr: string
    readonly resultXdr: string
    readonly resultMetaXdr: string
  }

/**
 * The distribution of the inclusion fees of recent transactions, in stroops per operation, over the last `ledgerCount`
 * ledgers. Every fee is 0 when they hold no transaction of the kind (`transactionCount` 0).
 *
 * @since 0.2.0
 * @category models
 */
export interface StellarFeeDistribution {
  readonly max: bigint
  readonly min: bigint
  readonly mode: bigint
  readonly p10: bigint
  readonly p20: bigint
  readonly p30: bigint
  readonly p40: bigint
  readonly p50: bigint
  readonly p60: bigint
  readonly p70: bigint
  readonly p80: bigint
  readonly p90: bigint
  readonly p95: bigint
  readonly p99: bigint
  readonly transactionCount: number
  readonly ledgerCount: number
}

/**
 * A `getFeeStats` reply: the inclusion fees of classic transactions and of Soroban transactions, which compete for
 * separate ledger space.
 *
 * @since 0.2.0
 * @category models
 */
export interface StellarFeeStats {
  readonly inclusionFee: StellarFeeDistribution
  readonly sorobanInclusionFee: StellarFeeDistribution
  readonly latestLedger: bigint
}

/**
 * A `simulateTransaction` reply. A Soroban transaction that would run has its `transactionData` (the base64
 * `SorobanTransactionData` XDR holding its footprint and resources), its `minResourceFee` in stroops and, for an
 * invocation, its `results`: the base64 `SorobanAuthorizationEntry` XDRs it needs as `auth` and its return value as
 * `xdr`. One that would not has the node's `error`.
 *
 * @since 0.2.0
 * @category models
 */
export type StellarSimulation =
  | { readonly error: string; readonly latestLedger: bigint }
  | {
    readonly transactionData: string
    readonly minResourceFee: bigint
    readonly results?: ReadonlyArray<{ readonly auth: ReadonlyArray<string>; readonly xdr: string }>
    readonly latestLedger: bigint
  }

/**
 * A `sendTransaction` reply. `PENDING` is accepted for a later ledger, `DUPLICATE` already held by the node, and
 * `TRY_AGAIN_LATER` not taken: neither says how the transaction ends. `ERROR` is refused, with the base64
 * `TransactionResult` XDR saying why.
 *
 * @since 0.2.0
 * @category models
 */
export interface StellarSentTransaction {
  readonly status: "PENDING" | "DUPLICATE" | "TRY_AGAIN_LATER" | "ERROR"
  readonly hash: StellarTransactionHash
  readonly latestLedger: bigint
  readonly errorResultXdr?: string
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
  /**
   * `getLedgers`, one page: up to `limit` ledgers from `startLedger` on, or after `cursor`. A page can be shorter than
   * `limit`. Fails `Pruned` on an endpoint that no longer retains the start and `Lagging` on one that has not closed
   * it yet, then falls back, except after a cursor. After a cursor at the latest ledger, a node answers an empty page
   * or fails `Lagging`, depending on its version.
   */
  readonly getLedgers: (options: StellarLedgersOptions) => Effect.Effect<StellarLedgersPage, StellarRpcError>
  /**
   * `getLedgerEntries`: the entries of the base64 `LedgerKey` XDRs `keys` at the endpoint's latest ledger, a missing
   * entry left out. Fails `Lagging` on an endpoint whose latest ledger is below `minLedger`, then falls back.
   */
  readonly getLedgerEntries: (options: {
    readonly keys: ReadonlyArray<string>
    readonly minLedger?: bigint | undefined
  }) => Effect.Effect<
    { readonly entries: ReadonlyArray<StellarLedgerEntry>; readonly latestLedger: bigint },
    StellarRpcError
  >
  /**
   * `getTransaction`: the transaction `hash` as the answering endpoint has it. An endpoint only holds the transactions
   * of the ledgers it retains, from `oldestLedger` on: an older transaction is `NOT_FOUND`, like one that was never
   * applied. `NOT_FOUND` is an answer, with no fallback to the next endpoint.
   */
  readonly getTransaction: (options: {
    readonly hash: StellarTransactionHash
  }) => Effect.Effect<StellarTransactionInfo, StellarRpcError>
  /** `getFeeStats` */
  readonly getFeeStats: Effect.Effect<StellarFeeStats, StellarRpcError>
  /**
   * `simulateTransaction`: runs the base64 `TransactionEnvelope` XDR `transaction`, signed or not, without sending
   * it. A transaction that would fail is an answer, with no fallback to the next endpoint.
   */
  readonly simulateTransaction: (options: {
    readonly transaction: string
  }) => Effect.Effect<StellarSimulation, StellarRpcError>
  /**
   * `sendTransaction`: submits the base64 `TransactionEnvelope` XDR `transaction`. Every status is an answer, with no
   * fallback to the next endpoint: read {@link StellarSentTransaction}. An envelope that is not XDR fails `Rejected`
   * without a request, and a reply for another hash than the envelope's fails `InvalidResponse`.
   */
  readonly sendTransaction: (options: {
    readonly transaction: string
  }) => Effect.Effect<StellarSentTransaction, StellarRpcError>
}>()("@effect-blockchain/stellar/StellarRpc") {}

// JSON-RPC internal error: stellar-rpc returns it for its own database or I/O failures, retry then fall back
const codes: ReadonlyMap<number, JsonRpc.CodeReason> = new Map([[-32603, "Unavailable"]])

// stellar-rpc's out-of-range start, current ("startLedger must be within the ledger range: X - Y") and older
// ("startLedger must be between the oldest ledger: X and the latest ledger: Y ..."), and on getLedgers ("start ledger
// (N) must be between the oldest ledger: X and the latest ledger: Y ...", "cursor ('N') must be between the oldest
// ledger: X and the latest ledger: Y ...", "cursor ('N') must be at or above the oldest ledger: X ...")
const ledgerRangeError = /(?:startLedger|start ledger \(\d+\)|cursor \('\d+'\)) must be \D*(\d+)(?:\D+(\d+))?/u

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
          reason: match[2] === undefined || start() < BigInt(match[1])
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

      const getLedgersOn = Effect.fnUntraced(function*(endpoint: Endpoint, options: StellarLedgersOptions) {
        const cursor = "cursor" in options ? options.cursor.cursor : undefined
        const start = "cursor" in options ? BigInt(options.cursor.cursor) + BigInt(1) : options.startLedger
        const page = yield* call(endpoint, RpcMethods.getLedgers, {
          ...(cursor === undefined ? { startLedger: start } : {}),
          pagination: {
            ...(options.limit === undefined ? {} : { limit: options.limit }),
            ...(cursor === undefined ? {} : { cursor })
          }
        }).pipe(Effect.mapError((error) => outOfRange(error, () => start)))
        yield* Ref.update(endpoint.head, BigInt_.max(page.latestLedger))
        // only a cursor at the latest ledger has an empty page
        if (
          (cursor === undefined && page.ledgers.length === 0) ||
          page.ledgers.some((ledger, index) => ledger.sequence !== start + BigInt(index))
        ) {
          return yield* fail(
            endpoint,
            RpcMethods.getLedgers.name,
            new JsonRpc.InvalidResponse(),
            new Error(`the page is not the ledgers from ${start} on`)
          )
        }
        return { ...page, cursor: StellarLedgersCursor.make({ endpoint: endpoint.name, cursor: page.cursor }) }
      })

      const archives = rpc.endpoints.filter((_, index) => options.endpoints[index].archive === true)

      return StellarRpc.of({
        network,
        getNetwork: withFallback(rpc.checkNetwork),
        getLatestLedger: withFallback((endpoint) =>
          call(endpoint, RpcMethods.getLatestLedger, undefined).pipe(
            Effect.tap((ledger) => Ref.update(endpoint.head, BigInt_.max(ledger.sequence)))
          )
        ),
        getLedgers: (options) => {
          const method = RpcMethods.getLedgers.name
          if ("cursor" in options) {
            return Effect.flatMap(rpc.endpointOf(method, options.cursor), (endpoint) => getLedgersOn(endpoint, options))
          }
          if (options.archive !== true) return withFallback((endpoint) => getLedgersOn(endpoint, options))
          return Arr.isReadonlyArrayNonEmpty(archives)
            ? withFallback((endpoint) => getLedgersOn(endpoint, options), archives)
            : Effect.fail(
              new StellarRpcError({
                reason: new JsonRpc.Rejected(),
                method,
                endpoint: "archive",
                cause: new Error("no endpoint is flagged archive")
              })
            )
        },
        getLedgerEntries: ({ keys, minLedger }) =>
          withFallback((endpoint) =>
            call(endpoint, RpcMethods.getLedgerEntries, { keys }).pipe(
              Effect.tap(({ latestLedger }) => Ref.update(endpoint.head, BigInt_.max(latestLedger))),
              Effect.flatMap(({ entries, latestLedger }) =>
                minLedger !== undefined && latestLedger < minLedger
                  ? Effect.fail(fail(
                    endpoint,
                    RpcMethods.getLedgerEntries.name,
                    new JsonRpc.Lagging({ head: latestLedger, toBlock: minLedger }),
                    new Error(`latest ledger ${latestLedger} is below ${minLedger}`)
                  ))
                  : Effect.succeed({ entries, latestLedger })
              )
            )
          ),
        getTransaction: ({ hash }) =>
          withFallback((endpoint) =>
            call(endpoint, RpcMethods.getTransaction, { hash: hash.slice(2) }).pipe(
              Effect.tap(({ latestLedger }) => Ref.update(endpoint.head, BigInt_.max(latestLedger)))
            )
          ),
        getFeeStats: withFallback((endpoint) =>
          call(endpoint, RpcMethods.getFeeStats, undefined).pipe(
            Effect.tap(({ latestLedger }) => Ref.update(endpoint.head, BigInt_.max(latestLedger)))
          )
        ),
        simulateTransaction: (options) =>
          withFallback((endpoint) =>
            call(endpoint, RpcMethods.simulateTransaction, options).pipe(
              Effect.tap(({ latestLedger }) => Ref.update(endpoint.head, BigInt_.max(latestLedger)))
            )
          ),
        sendTransaction: (options) =>
          withFallback((endpoint) => {
            const method = RpcMethods.sendTransaction.name
            return Effect.try({
              try: () => TransactionBuilder.fromXDR(options.transaction, passphrase).hash().toString("hex"),
              catch: () =>
                fail(
                  endpoint,
                  method,
                  new JsonRpc.Rejected(),
                  new Error("transaction is not a TransactionEnvelope XDR")
                )
            }).pipe(
              Effect.flatMap((hash) =>
                call(endpoint, RpcMethods.sendTransaction, options).pipe(
                  Effect.tap(({ latestLedger }) => Ref.update(endpoint.head, BigInt_.max(latestLedger))),
                  Effect.filterOrFail(
                    (sent) => sent.hash === `0x${hash}`,
                    (sent) =>
                      fail(endpoint, method, new JsonRpc.InvalidResponse(), new Error(`answered for ${sent.hash}`))
                  )
                )
              )
            )
          }),
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
