/**
 * EVM log indexing on top of {@link EvmRpc.EvmRpc}: the last confirmed block, the logs of a set of contracts over a
 * block range, and a stream of them following the confirmed head.
 *
 * Ranges are read in chunks of at most `maxBlockRange` blocks, one `eth_getLogs` after another. A failing chunk fails
 * the whole call and drops the logs already read: the caller retries the same range.
 *
 * @example
 * ```ts
 * import { EvmIndexer } from "@effect-blockchain/evm/EvmIndexer"
 * import type { EvmLogsFilter } from "@effect-blockchain/evm/EvmRpc"
 * import * as Effect from "effect/Effect"
 * import * as Schedule from "effect/Schedule"
 * import * as Stream from "effect/Stream"
 *
 * declare const filter: Omit<EvmLogsFilter, "fromBlock" | "toBlock">
 * declare const cursor: bigint
 * declare const save: (block: bigint) => Effect.Effect<void>
 *
 * const program = Effect.gen(function*() {
 *   const indexer = yield* EvmIndexer
 *   // once caught up, read the head after 1 s, 2 s, 4 s... at most every minute
 *   const poll = Schedule.min([Schedule.exponential("1 second"), Schedule.spaced("1 minute")])
 *   yield* indexer.streamLogs({ filter, fromBlock: cursor + BigInt(1), poll }).pipe(
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
import type { EvmLog } from "./EvmLog.ts"
import * as EvmNetwork from "./EvmNetwork.ts"
import * as EvmRpc from "./EvmRpc.ts"

/**
 * The logs of `[fromBlock, toBlock]` (both inclusive), in chain order, emitted by
 * {@link EvmIndexer.Service.streamLogs}.
 *
 * A batch is emitted for every range, even without logs. Delivery is at-least-once: save `batch.toBlock` once the
 * batch is handled and resume from `toBlock + 1`.
 *
 * @since 0.1.0
 * @category models
 */
export interface EvmIndexerBatch {
  readonly fromBlock: bigint
  readonly toBlock: bigint
  readonly logs: ReadonlyArray<EvmLog>
}

/**
 * @since 0.1.0
 * @category services
 */
export class EvmIndexer extends Context.Service<EvmIndexer, {
  /** The head block number minus the confirmations, never below 0. */
  readonly lastConfirmedBlock: Effect.Effect<bigint, EvmRpc.EvmRpcError>
  /**
   * The logs matching `filter` between `fromBlock` and `toBlock` (both inclusive), in chain order: sorted by block
   * then log index. `fromBlock > toBlock` returns `[]`. A `toBlock` above {@link lastConfirmedBlock} is accepted.
   */
  readonly fetchLogs: (filter: EvmRpc.EvmLogsFilter) => Effect.Effect<ReadonlyArray<EvmLog>, EvmRpc.EvmRpcError>
  /**
   * The logs matching `filter` from `fromBlock` on, in batches of at most `maxBlockRange` confirmed blocks, following
   * the confirmed head.
   */
  readonly streamLogs: (options: {
    readonly filter: Omit<EvmRpc.EvmLogsFilter, "fromBlock" | "toBlock">
    readonly fromBlock: bigint
    /** The stream ends after the batch reaching it, and is empty when `fromBlock > toBlock`. */
    readonly toBlock?: bigint | undefined
    /**
     * When to read the head again once caught up, `Schedule.spaced(DEFAULT_POLL_INTERVAL)` by default. It restarts
     * after each batch, and its end ends the stream: `Schedule.recurs(0)` drains to the head and stops.
     */
    readonly poll?: Schedule.Schedule<unknown> | undefined
    /** Retries a step failing with a transient reason ({@link JsonRpc.isTransient}) at the same block. Off by default. */
    readonly retry?: Schedule.Schedule<unknown, EvmRpc.EvmRpcError> | undefined
  }) => Stream.Stream<EvmIndexerBatch, EvmRpc.EvmRpcError>
}>()("@effect-blockchain/evm/EvmIndexer") {}

/**
 * The default `maxBlockRange`: most RPC providers accept `eth_getLogs` over 1000 blocks, lower it for stricter ones.
 *
 * @since 0.1.0
 * @category constants
 */
export const DEFAULT_MAX_BLOCK_RANGE = 1000

/**
 * The default `poll` spacing of {@link EvmIndexer.Service.streamLogs}: 10 seconds.
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
 * Builds an {@link EvmIndexer} reading through the provided {@link EvmRpc.EvmRpc}.
 *
 * - `confirmations` overrides {@link EvmNetwork.defaultConfirmations} for the RPC's network.
 * - `maxBlockRange`, a positive integer, defaults to {@link DEFAULT_MAX_BLOCK_RANGE}.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer = (options: {
  readonly confirmations?: number | undefined
  readonly maxBlockRange?: number | undefined
} = {}): Layer.Layer<EvmIndexer, never, EvmRpc.EvmRpc> =>
  Layer.effect(
    EvmIndexer,
    Effect.gen(function*() {
      const rpc = yield* EvmRpc.EvmRpc
      const maxBlockRange = options.maxBlockRange ?? DEFAULT_MAX_BLOCK_RANGE
      if (!Number.isSafeInteger(maxBlockRange) || maxBlockRange < 1) {
        return yield* Effect.die(new RangeError(`maxBlockRange must be a positive integer, got ${maxBlockRange}`))
      }
      const confirmations = BigInt(options.confirmations ?? EvmNetwork.defaultConfirmations(rpc.network))
      const size = BigInt(maxBlockRange)
      const lastConfirmedBlock = rpc.blockNumber.pipe(
        Effect.map((head) => BigInt_.max(head - confirmations, BigInt(0))),
        Effect.withSpan("EvmIndexer.lastConfirmedBlock")
      )
      const fetchLogs = Effect.fn("EvmIndexer.fetchLogs")((filter: EvmRpc.EvmLogsFilter) => {
        if (filter.fromBlock > filter.toBlock) return Effect.succeed([])
        const count = Number((filter.toBlock - filter.fromBlock) / size) + 1
        return Effect.forEach(
          Arr.makeBy(count, (i) => filter.fromBlock + BigInt(i) * size),
          (fromBlock) =>
            rpc.getLogs({ ...filter, fromBlock, toBlock: BigInt_.min(fromBlock + size - BigInt(1), filter.toBlock) })
        ).pipe(Effect.map(Arr.flatten))
      })
      return EvmIndexer.of({
        lastConfirmedBlock,
        fetchLogs,
        streamLogs: ({ filter, fromBlock, poll = Schedule.spaced(DEFAULT_POLL_INTERVAL), retry, toBlock }) => {
          if (toBlock !== undefined && fromBlock > toBlock) return Stream.empty
          // the head last read is reused while it covers `next` (the confirmed head only moves forward), else polled
          const step = (
            { head, next }: IndexerConfirmedRange
          ): Effect.Effect<
            readonly [ReadonlyArray<EvmIndexerBatch>, Option.Option<IndexerConfirmedRange>],
            EvmRpc.EvmRpcError
          > =>
            (next <= head
              ? Effect.succeed(head)
              : lastConfirmedBlock.pipe(Effect.repeat({ schedule: poll, until: (confirmed) => confirmed >= next })))
              .pipe(Effect.flatMap((confirmed) => {
                const cap = toBlock === undefined ? confirmed : BigInt_.min(confirmed, toBlock)
                if (next > cap) return Effect.succeed([[], Option.none()])
                const end = BigInt_.min(next + size - BigInt(1), cap)
                return fetchLogs({ ...filter, fromBlock: next, toBlock: end }).pipe(Effect.map((logs) => [
                  [{ fromBlock: next, toBlock: end, logs }],
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
 * Builds an {@link EvmIndexer} like {@link layer}, reading the options from `Config`.
 *
 * @example
 * ```ts
 * import * as EvmIndexer from "@effect-blockchain/evm/EvmIndexer"
 * import * as Config from "effect/Config"
 *
 * const IndexerLive = EvmIndexer.layerConfig({ confirmations: Config.Int("ETHEREUM_CONFIRMATIONS") })
 * ```
 *
 * @since 0.1.0
 * @category layers
 */
export const layerConfig = (
  options: Config.Wrap<NonNullable<Parameters<typeof layer>[0]>>
): Layer.Layer<EvmIndexer, Config.ConfigError, EvmRpc.EvmRpc> => Layer.unwrap(Effect.map(Config.unwrap(options), layer))
