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
 * @since 0.1.0
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import type { StarknetEvent } from "./StarknetEvent.ts"
import * as StarknetNetwork from "./StarknetNetwork.ts"
import type { StarknetEventsFilter, StarknetRpcError } from "./StarknetRpc.ts"
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
}>()("@effect-blockchain/starknet/StarknetIndexer") {}

/**
 * Builds a {@link StarknetIndexer} over the provided {@link StarknetRpc}.
 *
 * - `confirmations` defaults to {@link StarknetNetwork.defaultConfirmations} for the RPC's network.
 * - `maxBlockRange` is the largest chunk in blocks, default {@link DEFAULT_MAX_BLOCK_RANGE}.
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
      const confirmations = BigInt(options.confirmations ?? StarknetNetwork.defaultConfirmations(rpc.network))
      const maxBlockRange = BigInt(options.maxBlockRange ?? DEFAULT_MAX_BLOCK_RANGE)
      const zero = BigInt(0)
      const one = BigInt(1)

      // `restart`: whether a failed cursor page may still restart the chunk from its first page
      const fetchChunk = (
        filter: StarknetEventsFilter,
        restart: boolean
      ): Effect.Effect<Array<StarknetEvent>, StarknetRpcError> =>
        Effect.gen(function*() {
          const first = yield* rpc.getEvents(filter)
          const events = Array.from(first.events)
          let cursor = first.cursor
          while (cursor !== undefined) {
            const page = yield* Effect.result(rpc.getEvents({ ...filter, cursor }))
            if (Result.isFailure(page)) {
              return restart ? yield* fetchChunk(filter, false) : yield* Effect.fail(page.failure)
            }
            events.push(...page.success.events)
            cursor = page.success.cursor
          }
          return events
        })

      const fetchEvents = Effect.fnUntraced(function*(filter: StarknetIndexerFilter) {
        const events: Array<StarknetEvent> = []
        for (let fromBlock = filter.fromBlock; fromBlock <= filter.toBlock; fromBlock += maxBlockRange) {
          const toBlock = fromBlock + maxBlockRange - one
          events.push(
            ...yield* fetchChunk({
              ...filter,
              fromBlock,
              toBlock: toBlock < filter.toBlock ? toBlock : filter.toBlock,
              chunkSize: options.chunkSize
            }, true)
          )
        }
        return events
      })

      return StarknetIndexer.of({
        lastConfirmedBlock: rpc.blockNumber.pipe(
          Effect.map((head) => head - confirmations > zero ? head - confirmations : zero)
        ),
        fetchEvents
      })
    })
  )
