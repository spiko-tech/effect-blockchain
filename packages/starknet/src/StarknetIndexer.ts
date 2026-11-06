/**
 * Reads every confirmed event of a contract over a block range, on top of {@link StarknetRpc}.
 *
 * Range logic: `fetchEvents` splits `[fromBlock, toBlock]` into chunks of at most `maxBlockRange` blocks and reads
 * them one after another. Inside a chunk, it pages with `starknet_getEvents` and its continuation token until the
 * token is absent. Events come back in chain order.
 *
 * Failure behaviour: the first page of a chunk goes through the {@link StarknetRpc} fallback chain. A later page is
 * pinned to the endpoint that issued the cursor, so it has no fallback. When such a page fails, the chunk's partial
 * events are dropped and the chunk restarts once from its first page, through the fallback chain again. A second
 * failure of the same chunk, or a failure of a chunk's first page, fails the call with that {@link StarknetRpcError}.
 *
 * **Streaming**
 *
 * `streamEvents` follows the confirmed head from `fromBlock`: each step fetches the next `maxBlockRange` blocks at
 * most, up to the confirmed head, through `fetchEvents` (so with its chunk restart), as one {@link
 * StarknetIndexerBatch}. The head is read once per catch-up segment: `lastConfirmedBlock` is read again only once the
 * stream reaches the head it last read. A batch is emitted even when it has no events, so the caller's cursor moves on
 * a quiet contract. Caught up, the stream reads the head again on the `poll` schedule until it reaches the next block,
 * the schedule starting afresh after each batch; a bounded `poll`, e.g. `Schedule.recurs(0)`, drains to the head and
 * stops. With a `toBlock` it ends after the batch reaching it. With `retry`, a step failing with a transient reason
 * (`Unavailable`, `InvalidResponse`, `Lagging`), including a cursor page still failing after the chunk restart, is
 * retried at the same block; any other failure, or an exhausted schedule, fails the stream. Delivery is at-least-once:
 * save `batch.toBlock` after handling a batch and restart from the block after it. Run one stream per (network, filter)
 * at a time: the indexer does not coordinate processes, so a service with several replicas provides the exclusivity
 * itself, for example with a Postgres advisory lock.
 *
 * ```ts
 * import * as Effect from "effect/Effect"
 * import * as Schedule from "effect/Schedule"
 * import * as Stream from "effect/Stream"
 * import { StarknetIndexer } from "@effect-blockchain/starknet/StarknetIndexer"
 * import type { StarknetIndexerFilter } from "@effect-blockchain/starknet/StarknetIndexer"
 *
 * declare const filter: Omit<StarknetIndexerFilter, "fromBlock" | "toBlock">
 * declare const cursor: bigint
 * declare const save: (block: bigint) => Effect.Effect<void>
 *
 * const program = Effect.gen(function*() {
 *   const indexer = yield* StarknetIndexer
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
import * as Schedule from "effect/Schedule"
import * as Stream from "effect/Stream"
import type { StarknetEvent } from "./StarknetEvent.ts"
import * as StarknetNetwork from "./StarknetNetwork.ts"
import type { StarknetEventsCursor, StarknetEventsFilter, StarknetRpcError } from "./StarknetRpc.ts"
import { StarknetRpc } from "./StarknetRpc.ts"

/**
 * A {@link StarknetIndexer} `fetchEvents` filter: a `starknet_getEvents` filter without its paging fields, over the
 * inclusive block range `[fromBlock, toBlock]`.
 *
 * @since 0.1.0
 * @category models
 */
export type StarknetIndexerFilter = Omit<StarknetEventsFilter, "chunkSize" | "cursor">

/**
 * The events of `[fromBlock, toBlock]` (both inclusive), in chain order, emitted by
 * {@link StarknetIndexer.Service.streamEvents}. `events` can be empty.
 *
 * @since 0.1.0
 * @category models
 */
export interface StarknetIndexerBatch {
  readonly fromBlock: bigint
  readonly toBlock: bigint
  readonly events: ReadonlyArray<StarknetEvent>
}

/**
 * Default `maxBlockRange`. Starknet nodes put no limit on the block range of `starknet_getEvents` (they cap the page
 * size and page through the range), so the chunk only bounds the work a restart redoes and the range one request
 * scans: 10000 blocks is a few hours of mainnet.
 *
 * @since 0.1.0
 * @category constants
 */
export const DEFAULT_MAX_BLOCK_RANGE = 10_000

/**
 * @since 0.1.0
 * @category services
 */
export class StarknetIndexer extends Context.Service<StarknetIndexer, {
  /** The latest block with at least `confirmations` blocks on top of it, never below 0. */
  readonly lastConfirmedBlock: Effect.Effect<bigint, StarknetRpcError>
  /**
   * Every event matching `filter` in `[fromBlock, toBlock]`, in chain order. `fromBlock > toBlock` returns no events.
   * A `toBlock` above `lastConfirmedBlock` is accepted.
   */
  readonly fetchEvents: (filter: StarknetIndexerFilter) => Effect.Effect<ReadonlyArray<StarknetEvent>, StarknetRpcError>
  /**
   * The events matching `filter` from `fromBlock` on, one batch of at most `maxBlockRange` confirmed blocks at a time,
   * following the head: see the module's "Streaming" section.
   *
   * - `toBlock`: the stream ends after the batch reaching it. `fromBlock > toBlock` is an empty stream.
   * - `poll`: when to read the head again once caught up, defaults to `Schedule.spaced(DEFAULT_POLL_INTERVAL)`. A
   *   bounded schedule ends the stream when it is exhausted while still caught up.
   * - `retry`: retries a step failing with `Unavailable`, `InvalidResponse` or `Lagging` at the same block. Off by
   *   default: the first failure fails the stream.
   */
  readonly streamEvents: (options: {
    readonly filter: Omit<StarknetIndexerFilter, "fromBlock" | "toBlock">
    readonly fromBlock: bigint
    readonly toBlock?: bigint | undefined
    // the schedule's output is ignored
    readonly poll?: Schedule.Schedule<unknown> | undefined
    // the schedule's output is ignored
    readonly retry?: Schedule.Schedule<unknown, StarknetRpcError> | undefined
  }) => Stream.Stream<StarknetIndexerBatch, StarknetRpcError>
}>()("@effect-blockchain/starknet/StarknetIndexer") {}

/**
 * The default spacing of the `poll` schedule of {@link StarknetIndexer.Service.streamEvents}: the head is read again
 * every 10 seconds once caught up.
 *
 * @since 0.1.0
 * @category constants
 */
export const DEFAULT_POLL_INTERVAL: Duration.Duration = Duration.seconds(10)

// the confirmed blocks [next, head] not indexed yet, empty once the stream reaches the head it last read
interface IndexerConfirmedRange {
  readonly next: bigint
  readonly head: bigint
}

/**
 * Builds a {@link StarknetIndexer} over the provided {@link StarknetRpc}.
 *
 * - `confirmations` defaults to {@link StarknetNetwork.defaultConfirmations} for the RPC's network.
 * - `maxBlockRange` is the largest chunk in blocks, a positive integer, default {@link DEFAULT_MAX_BLOCK_RANGE}.
 * - `chunkSize` is the `starknet_getEvents` page size, default the RPC's (1000). Lower it for a provider with a
 *   smaller cap.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer = (options: {
  readonly confirmations?: number | undefined
  readonly maxBlockRange?: number | undefined
  readonly chunkSize?: number | undefined
} = {}): Layer.Layer<StarknetIndexer, never, StarknetRpc> =>
  Layer.effect(
    StarknetIndexer,
    Effect.gen(function*() {
      const rpc = yield* StarknetRpc
      const maxBlockRange = options.maxBlockRange ?? DEFAULT_MAX_BLOCK_RANGE
      if (!Number.isSafeInteger(maxBlockRange) || maxBlockRange < 1) {
        return yield* Effect.die(new RangeError(`maxBlockRange must be a positive integer, got ${maxBlockRange}`))
      }
      const confirmations = BigInt(options.confirmations ?? StarknetNetwork.defaultConfirmations(rpc.network))
      const size = BigInt(maxBlockRange)
      const lastConfirmedBlock = rpc.blockNumber.pipe(
        Effect.map((head) => BigInt_.max(head - confirmations, BigInt(0))),
        Effect.withSpan("StarknetIndexer.lastConfirmedBlock")
      )
      const fetchEvents = Effect.fn("StarknetIndexer.fetchEvents")((filter: StarknetIndexerFilter) =>
        Effect.forEach(
          filter.fromBlock > filter.toBlock ? [] : Arr.makeBy(
            Number((filter.toBlock - filter.fromBlock) / size) + 1,
            (i) => filter.fromBlock + BigInt(i) * size
          ),
          (fromBlock) => {
            const toBlock = BigInt_.min(fromBlock + size - BigInt(1), filter.toBlock)
            const chunk = { ...filter, fromBlock, toBlock, chunkSize: options.chunkSize }
            // pages until the cursor is absent. The first page (no cursor) has the fallback chain, a cursor page has
            // not: a failed cursor page drops the chunk's events and restarts it once from its first page
            return Stream.paginate(
              Option.none<StarknetEventsCursor>(),
              (cursor) =>
                rpc.getEvents({ ...chunk, cursor: Option.getOrUndefined(cursor) }).pipe(Effect.mapBoth({
                  onFailure: (error) => Option.isNone(cursor) ? error : { cursorPage: error },
                  onSuccess: (page) =>
                    [page.events, Option.map(Option.fromUndefinedOr(page.cursor), Option.some)] as const
                }))
            ).pipe(
              Stream.runCollect,
              Effect.retry({ times: 1, while: (error) => "cursorPage" in error }),
              Effect.mapError((error) => "cursorPage" in error ? error.cursorPage : error)
            )
          }
        ).pipe(Effect.map(Arr.flatten))
      )
      return StarknetIndexer.of({
        lastConfirmedBlock,
        fetchEvents,
        streamEvents: ({ filter, fromBlock, poll = Schedule.spaced(DEFAULT_POLL_INTERVAL), retry, toBlock }) => {
          if (toBlock !== undefined && fromBlock > toBlock) return Stream.empty
          // one step from the next block to read: the head last read when it reaches `next` (the confirmed head
          // only moves forward), otherwise the head polled on `poll` until it does (an exhausted `poll` ends the
          // stream), then a batch up to it
          const step = (
            { head, next }: IndexerConfirmedRange
          ): Effect.Effect<
            readonly [ReadonlyArray<StarknetIndexerBatch>, Option.Option<IndexerConfirmedRange>],
            StarknetRpcError
          > =>
            (next <= head
              ? Effect.succeed(head)
              : lastConfirmedBlock.pipe(Effect.repeat({ schedule: poll, until: (confirmed) => confirmed >= next })))
              .pipe(Effect.flatMap((confirmed) => {
                const cap = toBlock === undefined ? confirmed : BigInt_.min(confirmed, toBlock)
                if (next > cap) return Effect.succeed([[], Option.none()])
                const end = BigInt_.min(next + size - BigInt(1), cap)
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
 * Builds an {@link StarknetIndexer} like {@link layer}, reading the options from `Config`.
 *
 * @example
 * ```ts
 * import * as StarknetIndexer from "@effect-blockchain/starknet/StarknetIndexer"
 * import * as Config from "effect/Config"
 *
 * const IndexerLive = StarknetIndexer.layerConfig({ confirmations: Config.Int("STARKNET_CONFIRMATIONS") })
 * ```
 *
 * @since 0.1.0
 * @category layers
 */
export const layerConfig = (
  options: Config.Wrap<NonNullable<Parameters<typeof layer>[0]>>
): Layer.Layer<StarknetIndexer, Config.ConfigError, StarknetRpc> =>
  Layer.unwrap(Effect.map(Config.unwrap(options), layer))
