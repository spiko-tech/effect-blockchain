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
 * `streamEvents` follows the confirmed head from `fromBlock`: each step reads `lastConfirmedBlock` and fetches the next
 * `maxBlockRange` blocks at most, up to it, through `fetchEvents` (so with its chunk restart), as one
 * {@link StarknetIndexerBatch}. A batch is emitted even when it has no events, so the caller's cursor moves on a quiet
 * contract. Caught up, the stream sleeps `pollInterval` and checks again; with a `toBlock` it ends after the batch
 * reaching it. With `retry`, a step failing with a transient reason (`Unavailable`, `InvalidResponse`, `Lagging`),
 * including a cursor page still failing after the chunk restart, is retried at the same block; any other failure, or
 * an exhausted schedule, fails the stream. Delivery is at-least-once: save `batch.toBlock` after handling a batch and
 * restart from the block after it. Run one stream per (network, filter) at a time: the indexer does not coordinate
 * processes, so a service with several replicas provides the exclusivity itself, for example with a Postgres advisory
 * lock.
 *
 * ```ts
 * import * as Effect from "effect/Effect"
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
 *   yield* indexer.streamEvents({ filter, fromBlock: cursor + BigInt(1) }).pipe(
 *     Stream.runForEach((batch) => save(batch.toBlock))
 *   )
 * })
 * ```
 *
 * @since 0.1.0
 */
import * as Arr from "effect/Array"
import * as BigInt_ from "effect/BigInt"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import type * as Schedule from "effect/Schedule"
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
   * - `pollInterval`: the wait once caught up, defaults to {@link DEFAULT_POLL_INTERVAL}.
   * - `retry`: retries a step failing with `Unavailable`, `InvalidResponse` or `Lagging` at the same block. Off by
   *   default: the first failure fails the stream.
   */
  readonly streamEvents: (options: {
    readonly filter: Omit<StarknetIndexerFilter, "fromBlock" | "toBlock">
    readonly fromBlock: bigint
    readonly toBlock?: bigint | undefined
    readonly pollInterval?: Duration.Input | undefined
    // the schedule's output is ignored
    readonly retry?: Schedule.Schedule<unknown, StarknetRpcError> | undefined
  }) => Stream.Stream<StarknetIndexerBatch, StarknetRpcError>
}>()("@effect-blockchain/starknet/StarknetIndexer") {}

/**
 * The default `pollInterval` of {@link StarknetIndexer.Service.streamEvents}: the wait before reading the head again
 * once caught up.
 *
 * @since 0.1.0
 * @category constants
 */
export const DEFAULT_POLL_INTERVAL: Duration.Duration = Duration.seconds(10)

// the reasons a later attempt can fix: the others answer the same at the same block
const isTransient = (error: StarknetRpcError): boolean =>
  error.reason === "Unavailable" || error.reason === "InvalidResponse" || error.reason === "Lagging"

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
        streamEvents: ({ filter, fromBlock, pollInterval = DEFAULT_POLL_INTERVAL, retry, toBlock }) => {
          if (toBlock !== undefined && fromBlock > toBlock) return Stream.empty
          // one step from the next block to read: a batch up to the confirmed head, or a sleep once caught up
          const step = (
            next: bigint
          ): Effect.Effect<readonly [ReadonlyArray<StarknetIndexerBatch>, Option.Option<bigint>], StarknetRpcError> =>
            lastConfirmedBlock.pipe(
              Effect.flatMap((confirmed) => {
                const cap = toBlock === undefined ? confirmed : BigInt_.min(confirmed, toBlock)
                if (next > cap) return Effect.as(Effect.sleep(pollInterval), [[], Option.some(next)])
                const end = BigInt_.min(next + size - BigInt(1), cap)
                return fetchEvents({ ...filter, fromBlock: next, toBlock: end }).pipe(Effect.map((events) => [
                  [{ fromBlock: next, toBlock: end, events }],
                  end === toBlock ? Option.none() : Option.some(end + BigInt(1))
                ]))
              })
            )
          return Stream.paginate(
            fromBlock,
            retry === undefined ? step : (next) => Effect.retry(step(next), { schedule: retry, while: isTransient })
          )
        }
      })
    })
  )
