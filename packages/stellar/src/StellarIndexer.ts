/**
 * Soroban contract event indexing on top of {@link StellarRpc}: the last confirmed ledger, the events of a set of
 * contracts over a ledger range, and a stream of them following the confirmed head.
 *
 * A range is split into ranges of at most `maxBlockRange` ledgers, each paged with `getEvents` until its cursor is
 * `undefined`. `contractIds` is split into groups of 5, the RPC limit per filter (`MaxContractIDsLimit` in
 * https://github.com/stellar/go-stellar-sdk/blob/main/protocols/rpc/get_events.go), merged back in event id order. A
 * cursor page is pinned to the endpoint that issued it, so when it fails the group restarts once from its first page.
 * Any other failure fails the whole call and drops the events already read: the caller retries the same range.
 *
 * @example
 * ```ts
 * import type { StellarIndexerFilter } from "@effect-blockchain/stellar/StellarIndexer"
 * import { StellarIndexer } from "@effect-blockchain/stellar/StellarIndexer"
 * import * as Effect from "effect/Effect"
 * import * as Schedule from "effect/Schedule"
 * import * as Stream from "effect/Stream"
 *
 * declare const filter: Omit<StellarIndexerFilter, "fromBlock" | "toBlock">
 * declare const cursor: bigint
 * declare const save: (ledger: bigint) => Effect.Effect<void>
 *
 * const program = Effect.gen(function*() {
 *   const indexer = yield* StellarIndexer
 *   // once caught up, read the head after 1 s, 2 s, 4 s... at most every minute
 *   const poll = Schedule.min([Schedule.exponential("1 second"), Schedule.spaced("1 minute")])
 *   yield* indexer.streamEvents({ filter, fromBlock: cursor + BigInt(1), poll }).pipe(
 *     Stream.runForEach((batch) => save(batch.toBlock))
 *   )
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
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Order from "effect/Order"
import * as Schedule from "effect/Schedule"
import * as Stream from "effect/Stream"
import type { StellarContractEvent } from "./StellarContractEvent.ts"
import * as StellarNetwork from "./StellarNetwork.ts"
import type { StellarEventsCursor, StellarEventsFilter, StellarRpcError } from "./StellarRpc.ts"
import { StellarRpc } from "./StellarRpc.ts"

/**
 * The default `maxBlockRange`: 10000 ledgers, the most a Stellar RPC scans per request (`LedgerScanLimit` in
 * https://github.com/stellar/stellar-rpc/blob/main/cmd/stellar-rpc/internal/methods/get_events.go).
 *
 * @since 0.1.0
 * @category constants
 */
export const DEFAULT_MAX_BLOCK_RANGE = 10_000

/**
 * A {@link StellarEventsFilter} without its paging fields (`limit`, `cursor`), over the inclusive ledger range
 * `[fromBlock, toBlock]`. `contractIds` has no size limit here.
 *
 * @since 0.1.0
 * @category models
 */
export type StellarIndexerFilter = Omit<StellarEventsFilter, "limit" | "cursor">

/**
 * The events of the ledgers `[fromBlock, toBlock]` (both inclusive), in chain order, emitted by
 * {@link StellarIndexer.Service.streamEvents}.
 *
 * A batch is emitted for every range, even without events. Delivery is at-least-once: save `batch.toBlock` once the
 * batch is handled and resume from `toBlock + 1`. RPC nodes keep about 7 days of ledgers: an older `fromBlock` fails
 * the stream with `Pruned`.
 *
 * @since 0.1.0
 * @category models
 */
export interface StellarIndexerBatch {
  readonly fromBlock: bigint
  readonly toBlock: bigint
  readonly events: ReadonlyArray<StellarContractEvent>
}

/**
 * The {@link StellarIndexer.Service.streamEvents} options.
 *
 * @since 0.1.0
 * @category models
 */
export interface StellarIndexerStreamOptions {
  readonly filter: Omit<StellarIndexerFilter, "fromBlock" | "toBlock">
  readonly fromBlock: bigint
  /** The stream ends after the batch reaching it, and is empty when `fromBlock > toBlock`. */
  readonly toBlock?: bigint | undefined
  /**
   * When to read the head again once caught up, `Schedule.spaced(DEFAULT_POLL_INTERVAL)` by default. It restarts after
   * each batch, and its end ends the stream: `Schedule.recurs(0)` drains to the head and stops.
   */
  readonly poll?: Schedule.Schedule<unknown> | undefined
  /** Retries a step failing with a transient reason ({@link JsonRpc.isTransient}) at the same ledger. Off by default. */
  readonly retry?: Schedule.Schedule<unknown, StellarRpcError> | undefined
}

/**
 * @since 0.1.0
 * @category services
 */
export class StellarIndexer extends Context.Service<StellarIndexer, {
  /** The latest ledger minus the configured confirmations, never below 0. */
  readonly lastConfirmedBlock: Effect.Effect<bigint, StellarRpcError>
  /**
   * Every contract event matching `filter`, in chain order (event id order). Events of failed contract calls
   * (`inSuccessfulContractCall: false`) are dropped. `fromBlock > toBlock` returns no events.
   */
  readonly fetchEvents: (
    filter: StellarIndexerFilter
  ) => Effect.Effect<ReadonlyArray<StellarContractEvent>, StellarRpcError>
  /**
   * The events matching `filter` from `fromBlock` on, in batches of at most `maxBlockRange` confirmed ledgers,
   * following the confirmed head.
   */
  readonly streamEvents: (options: StellarIndexerStreamOptions) => Stream.Stream<StellarIndexerBatch, StellarRpcError>
}>()("@effect-blockchain/stellar/StellarIndexer") {}

/**
 * The default `poll` spacing of {@link StellarIndexer.Service.streamEvents}: 10 seconds.
 *
 * @since 0.1.0
 * @category constants
 */
export const DEFAULT_POLL_INTERVAL: Duration.Duration = Duration.seconds(10)

const MAX_CONTRACT_IDS = 5

const byId = Order.mapInput(Order.String, (event: StellarContractEvent) => event.id)

// the confirmed ledgers [next, head] not indexed yet, empty once the stream reaches the head it last read
interface StreamPosition {
  readonly next: bigint
  readonly head: bigint
}

/**
 * Builds a {@link StellarIndexer} over the provided {@link StellarRpc}.
 *
 * - `confirmations`: ledgers kept behind the latest one, default {@link StellarNetwork.defaultConfirmations} of the
 *   RPC's network.
 * - `maxBlockRange`: ledgers per range, a positive integer, default {@link DEFAULT_MAX_BLOCK_RANGE}.
 * - `limit`: `getEvents` page size, default 1000, at most 10000.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer = (options: {
  readonly confirmations?: number | undefined
  readonly maxBlockRange?: number | undefined
  readonly limit?: number | undefined
} = {}): Layer.Layer<StellarIndexer, never, StellarRpc> =>
  Layer.effect(
    StellarIndexer,
    Effect.gen(function*() {
      const rpc = yield* StellarRpc
      const maxBlockRange = options.maxBlockRange ?? DEFAULT_MAX_BLOCK_RANGE
      if (!Number.isSafeInteger(maxBlockRange) || maxBlockRange < 1) {
        return yield* Effect.die(new RangeError(`maxBlockRange must be a positive integer, got ${maxBlockRange}`))
      }
      const confirmations = BigInt(options.confirmations ?? StellarNetwork.defaultConfirmations(rpc.network))
      const range = BigInt(maxBlockRange)
      const { limit } = options

      const lastConfirmedBlock = rpc.getLatestLedger.pipe(
        Effect.map((ledger) => BigInt_.max(ledger.sequence - confirmations, BigInt(0))),
        Effect.withSpan("StellarIndexer.lastConfirmedBlock")
      )
      const fetchEvents = Effect.fn("StellarIndexer.fetchEvents")((filter: StellarIndexerFilter) => {
        if (filter.fromBlock > filter.toBlock) return Effect.succeed([])
        const groups = Arr.chunksOf(filter.contractIds, MAX_CONTRACT_IDS)
        const starts = Arr.makeBy(
          Number((filter.toBlock - filter.fromBlock) / range) + 1,
          (i) => filter.fromBlock + BigInt(i) * range
        )
        return Effect.forEach(starts, (fromBlock) => {
          const toBlock = BigInt_.min(fromBlock + range - BigInt(1), filter.toBlock)
          return Effect.forEach(groups, (contractIds) => {
            const group = { ...filter, contractIds, fromBlock, toBlock, limit }
            // a cursor page has no fallback: when it fails, the group restarts once from its first page
            return Stream.paginate(
              Option.none<StellarEventsCursor>(),
              (cursor) =>
                rpc.getEvents({ ...group, cursor: Option.getOrUndefined(cursor) }).pipe(Effect.mapBoth({
                  onFailure: (error) => Option.isNone(cursor) ? error : { cursorPage: error },
                  onSuccess: (page) =>
                    [page.events, Option.map(Option.fromUndefinedOr(page.cursor), Option.some)] as const
                }))
            ).pipe(
              Stream.runCollect,
              Effect.retry({ times: 1, while: (error) => "cursorPage" in error }),
              Effect.mapError((error) => "cursorPage" in error ? error.cursorPage : error)
            )
          }).pipe(Effect.map((found) => groups.length > 1 ? Arr.sort(Arr.flatten(found), byId) : Arr.flatten(found)))
        }).pipe(Effect.map((ranges) => Arr.flatten(ranges).filter((event) => event.inSuccessfulContractCall)))
      })
      return StellarIndexer.of({
        lastConfirmedBlock,
        fetchEvents,
        streamEvents: ({ filter, fromBlock, poll = Schedule.spaced(DEFAULT_POLL_INTERVAL), retry, toBlock }) => {
          if (toBlock !== undefined && fromBlock > toBlock) return Stream.empty
          // the head last read is reused while it covers `next` (the confirmed head only moves forward), else polled
          const step = (
            { head, next }: StreamPosition
          ): Effect.Effect<
            readonly [ReadonlyArray<StellarIndexerBatch>, Option.Option<StreamPosition>],
            StellarRpcError
          > =>
            (next <= head
              ? Effect.succeed(head)
              : lastConfirmedBlock.pipe(Effect.repeat({ schedule: poll, until: (confirmed) => confirmed >= next })))
              .pipe(Effect.flatMap((confirmed) => {
                const cap = toBlock === undefined ? confirmed : BigInt_.min(confirmed, toBlock)
                if (next > cap) return Effect.succeed([[], Option.none()])
                const end = BigInt_.min(next + range - BigInt(1), cap)
                return fetchEvents({ ...filter, fromBlock: next, toBlock: end }).pipe(Effect.map((events) => [
                  [{ fromBlock: next, toBlock: end, events }],
                  end === toBlock ? Option.none() : Option.some({ next: end + BigInt(1), head: confirmed })
                ]))
              }))
          return Stream.paginate(
            // a head below `fromBlock`: the first step reads it
            { next: fromBlock, head: fromBlock - BigInt(1) },
            retry === undefined
              ? step
              : (remaining) =>
                Effect.retry(step(remaining), { schedule: retry, while: (error) => JsonRpc.isTransient(error.reason) })
          )
        }
      })
    })
  )

/**
 * Builds an {@link StellarIndexer} like {@link layer}, reading the options from `Config`.
 *
 * @example
 * ```ts
 * import * as StellarIndexer from "@effect-blockchain/stellar/StellarIndexer"
 * import * as Config from "effect/Config"
 *
 * const IndexerLive = StellarIndexer.layerConfig({ confirmations: Config.Int("STELLAR_CONFIRMATIONS") })
 * ```
 *
 * @since 0.1.0
 * @category layers
 */
export const layerConfig = (
  options: Config.Wrap<NonNullable<Parameters<typeof layer>[0]>>
): Layer.Layer<StellarIndexer, Config.ConfigError, StellarRpc> =>
  Layer.unwrap(Effect.map(Config.unwrap(options), layer))
