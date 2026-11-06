/**
 * Starknet event indexing on top of {@link StarknetRpc}: the last confirmed block, the events of a contract over a
 * block range, and a stream of them following the confirmed head.
 *
 * Ranges are read in chunks of at most `maxBlockRange` blocks, each paged with `starknet_getEvents` until its
 * continuation token is absent. A cursor page is pinned to the endpoint that issued it, so when it fails the chunk
 * restarts once from its first page, through the fallback again. Any other failure fails the whole call and drops the
 * events already read: the caller retries the same range.
 *
 * @example
 * ```ts
 * import type { StarknetIndexerFilter } from "@effect-blockchain/starknet/StarknetIndexer"
 * import { StarknetIndexer } from "@effect-blockchain/starknet/StarknetIndexer"
 * import * as Effect from "effect/Effect"
 * import * as Schedule from "effect/Schedule"
 * import * as Stream from "effect/Stream"
 *
 * declare const filter: Omit<StarknetIndexerFilter, "fromBlock" | "toBlock">
 * declare const cursor: bigint
 * declare const save: (block: bigint) => Effect.Effect<void>
 *
 * const program = Effect.gen(function*() {
 *   const indexer = yield* StarknetIndexer
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
 * {@link StarknetIndexer.Service.streamEvents}.
 *
 * A batch is emitted for every range, even without events. Delivery is at-least-once: save `batch.toBlock` once the
 * batch is handled and resume from `toBlock + 1`.
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
 * The default `maxBlockRange`. Starknet nodes do not limit the block range of `starknet_getEvents` (they cap the page
 * size), so a chunk only bounds the work a restart redoes: 10000 blocks is a few hours of mainnet.
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
   * The events matching `filter` from `fromBlock` on, in batches of at most `maxBlockRange` confirmed blocks, following
   * the confirmed head.
   */
  readonly streamEvents: (options: {
    readonly filter: Omit<StarknetIndexerFilter, "fromBlock" | "toBlock">
    readonly fromBlock: bigint
    /** The stream ends after the batch reaching it, and is empty when `fromBlock > toBlock`. */
    readonly toBlock?: bigint | undefined
    /**
     * When to read the head again once caught up, `Schedule.spaced(DEFAULT_POLL_INTERVAL)` by default. It restarts
     * after each batch, and its end ends the stream: `Schedule.recurs(0)` drains to the head and stops.
     */
    readonly poll?: Schedule.Schedule<unknown> | undefined
    /** Retries a step failing with a transient reason ({@link JsonRpc.isTransient}) at the same block. Off by default. */
    readonly retry?: Schedule.Schedule<unknown, StarknetRpcError> | undefined
  }) => Stream.Stream<StarknetIndexerBatch, StarknetRpcError>
}>()("@effect-blockchain/starknet/StarknetIndexer") {}

/**
 * The default `poll` spacing of {@link StarknetIndexer.Service.streamEvents}: 10 seconds.
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
 * - `chunkSize` is the `starknet_getEvents` page size, default 1000: lower it for a provider with a smaller cap.
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
            // a cursor page has no fallback: when it fails, the chunk restarts once from its first page
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
          // the head last read is reused while it covers `next` (the confirmed head only moves forward), else polled
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
