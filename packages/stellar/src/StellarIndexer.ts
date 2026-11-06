/**
 * Raw Soroban contract event indexer over {@link StellarRpc}: every event of a `getEvents` filter over any ledger
 * range, in chain order.
 *
 * Range logic, sequential:
 * - the range is cut into chunks of at most `maxBlockRange` ledgers,
 * - `contractIds` is cut into groups of at most 5, the RPC limit per filter (`MaxContractIDsLimit` in
 *   https://github.com/stellar/go-stellar-sdk/blob/main/protocols/rpc/get_events.go). Each group is fetched over the
 *   chunk and the chunk's events are merged in event id order, which is chain order,
 * - inside a chunk, `getEvents` is paged with its cursor until the cursor is `undefined`.
 *
 * Failures: the first page of a chunk goes through the RPC fallback, so its error is final. A later page is pinned to
 * the endpoint that issued the cursor and has no fallback: when it fails, the group's partial events in the chunk are
 * dropped and the group restarts once from its first page (on any endpoint). A second cursor page failure fails the call with
 * that error. Every error is a {@link StellarRpcError}, e.g. `Pruned` when no endpoint retains `fromBlock`.
 *
 * **Streaming**
 *
 * `streamEvents` follows the confirmed latest ledger from `fromBlock`: each step fetches the next `maxBlockRange`
 * ledgers at most, up to the confirmed head, through `fetchEvents`, as one {@link StellarIndexerBatch}. The head is
 * read once per catch-up segment: `lastConfirmedBlock` is read again only once the stream reaches the head it last
 * read. A batch is emitted even when it has no events, so the caller's cursor moves on a quiet contract. Caught up, the
 * stream reads the head again on the `poll` schedule until it reaches the next ledger, the schedule starting afresh
 * after each batch; a bounded `poll`, e.g. `Schedule.recurs(0)`, drains to the head and stops. With a `toBlock` it ends
 * after the batch reaching it. With `retry`, a step failing with a transient reason (`Unavailable`, `InvalidResponse`,
 * `Lagging`) is retried at the same ledger; any other failure, or an exhausted schedule, fails the stream. `Pruned` is
 * one of them: RPC nodes keep about 7 days of ledgers, so a `fromBlock` older than that fails the stream at once and
 * the caller picks a newer `fromBlock`. Delivery is at-least-once: save `batch.toBlock` after handling a batch and
 * restart from the ledger after it. Run one stream per (network, filter) at a time: the indexer does not coordinate
 * processes, so a service with several replicas provides the exclusivity itself, for example with a Postgres advisory
 * lock.
 *
 * ```ts
 * import * as Effect from "effect/Effect"
 * import * as Schedule from "effect/Schedule"
 * import * as Stream from "effect/Stream"
 * import { StellarIndexer } from "@effect-blockchain/stellar/StellarIndexer"
 * import type { StellarIndexerFilter } from "@effect-blockchain/stellar/StellarIndexer"
 *
 * declare const filter: Omit<StellarIndexerFilter, "fromBlock" | "toBlock">
 * declare const cursor: bigint
 * declare const save: (ledger: bigint) => Effect.Effect<void>
 *
 * const program = Effect.gen(function*() {
 *   const indexer = yield* StellarIndexer
 *   // idle, wait 1 s, 2 s, 4 s... between head reads, at most 1 minute
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
 * Default `maxBlockRange`: 10000 ledgers, the most a Stellar RPC scans per request (`LedgerScanLimit` in
 * https://github.com/stellar/stellar-rpc/blob/main/cmd/stellar-rpc/internal/methods/get_events.go), so a chunk with
 * fewer events than the page size is done in one request.
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
 * {@link StellarIndexer.Service.streamEvents}. `events` can be empty.
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
   * The events matching `filter` from `fromBlock` on, one batch of at most `maxBlockRange` confirmed ledgers at a
   * time, following the latest ledger: see the module's "Streaming" section.
   *
   * - `toBlock`: the stream ends after the batch reaching it. `fromBlock > toBlock` is an empty stream.
   * - `poll`: when to read the head again once caught up, defaults to `Schedule.spaced(DEFAULT_POLL_INTERVAL)`. A
   *   bounded schedule ends the stream when it is exhausted while still caught up.
   * - `retry`: retries a step failing with `Unavailable`, `InvalidResponse` or `Lagging` at the same ledger. Off by
   *   default: the first failure fails the stream. `Pruned` is never retried.
   */
  readonly streamEvents: (options: {
    readonly filter: Omit<StellarIndexerFilter, "fromBlock" | "toBlock">
    readonly fromBlock: bigint
    readonly toBlock?: bigint | undefined
    // the schedule's output is ignored
    readonly poll?: Schedule.Schedule<unknown> | undefined
    // the schedule's output is ignored
    readonly retry?: Schedule.Schedule<unknown, StellarRpcError> | undefined
  }) => Stream.Stream<StellarIndexerBatch, StellarRpcError>
}>()("@effect-blockchain/stellar/StellarIndexer") {}

/**
 * The default spacing of the `poll` schedule of {@link StellarIndexer.Service.streamEvents}: the head is read again
 * every 10 seconds once caught up.
 *
 * @since 0.1.0
 * @category constants
 */
export const DEFAULT_POLL_INTERVAL: Duration.Duration = Duration.seconds(10)

const MAX_CONTRACT_IDS = 5

const byId = Order.mapInput(Order.String, (event: StellarContractEvent) => event.id)

// a stream's position: the next ledger to read and the confirmed head last read
interface Position {
  readonly next: bigint
  readonly head: bigint
}

/**
 * Builds a {@link StellarIndexer} over the provided {@link StellarRpc}.
 *
 * - `confirmations`: ledgers kept behind the latest one, default {@link StellarNetwork.defaultConfirmations} of the
 *   RPC's network.
 * - `maxBlockRange`: ledgers per chunk, a positive integer, default {@link DEFAULT_MAX_BLOCK_RANGE}.
 * - `limit`: `getEvents` page size, default the RPC's (1000), at most 10000.
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
        const chunks = Arr.makeBy(
          Number((filter.toBlock - filter.fromBlock) / range) + 1,
          (i) => filter.fromBlock + BigInt(i) * range
        )
        return Effect.forEach(chunks, (fromBlock) => {
          const toBlock = BigInt_.min(fromBlock + range - BigInt(1), filter.toBlock)
          return Effect.forEach(groups, (contractIds) => {
            const group = { ...filter, contractIds, fromBlock, toBlock, limit }
            // pages until the cursor is undefined. The first page (no cursor) has the fallback chain, a cursor page
            // has not: a failed cursor page drops the group's events and restarts it once from its first page
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
        }).pipe(Effect.map((chunks) => Arr.flatten(chunks).filter((event) => event.inSuccessfulContractCall)))
      })
      return StellarIndexer.of({
        lastConfirmedBlock,
        fetchEvents,
        streamEvents: ({ filter, fromBlock, poll = Schedule.spaced(DEFAULT_POLL_INTERVAL), retry, toBlock }) => {
          if (toBlock !== undefined && fromBlock > toBlock) return Stream.empty
          // one step from the next ledger to read: the head last read when it reaches `next` (the confirmed head
          // only moves forward), otherwise the head polled on `poll` until it does (an exhausted `poll` ends the
          // stream), then a batch up to it
          const step = (
            { head, next }: Position
          ): Effect.Effect<readonly [ReadonlyArray<StellarIndexerBatch>, Option.Option<Position>], StellarRpcError> =>
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
              : (position) =>
                Effect.retry(step(position), { schedule: retry, while: (error) => JsonRpc.isTransient(error.reason) })
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
