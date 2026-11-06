/**
 * A raw EVM log indexer on top of {@link EvmRpc.EvmRpc}: the last confirmed block and the logs of a set of contracts
 * over any block range.
 *
 * `fetchLogs` splits `[fromBlock, toBlock]` into consecutive chunks of at most `maxBlockRange` blocks and sends one
 * `eth_getLogs` per chunk, one after another. Each chunk comes back in chain order, so the concatenation is too.
 * The first failing chunk fails the whole call with its {@link EvmRpc.EvmRpcError}, after `EvmRpc`'s own retries and
 * fallback, and the logs of the chunks before it are dropped: the caller restarts from `fromBlock`.
 *
 * **Streaming**
 *
 * `streamLogs` follows the confirmed head from `fromBlock`: each step fetches the next `maxBlockRange` blocks at most,
 * up to the confirmed head, as one {@link EvmIndexerBatch}. The head is read once per catch-up segment:
 * `lastConfirmedBlock` is read again only once the stream reaches the head it last read. A batch is emitted even when
 * it has no logs, so the caller's cursor moves on a quiet contract. Caught up, the stream reads the head again on the
 * `poll` schedule until it reaches the next block, the schedule starting afresh after each batch; a bounded `poll`,
 * e.g. `Schedule.recurs(0)`, drains to the head and stops. With a `toBlock` it ends after the batch reaching it. With
 * `retry`, a step failing with a transient reason (`Unavailable`, `InvalidResponse`, `Lagging`) is retried at the same
 * block; any other failure, or an exhausted schedule, fails the stream. Delivery is at-least-once: save `batch.toBlock`
 * after handling a batch and restart from the block after it. Run one stream per (network, filter) at a time: the
 * indexer does not coordinate processes, so a service with several replicas provides the exclusivity itself, for
 * example with a Postgres advisory lock.
 *
 * ```ts
 * import * as Effect from "effect/Effect"
 * import * as Schedule from "effect/Schedule"
 * import * as Stream from "effect/Stream"
 * import { EvmIndexer } from "@effect-blockchain/evm/EvmIndexer"
 * import type { EvmLogsFilter } from "@effect-blockchain/evm/EvmRpc"
 *
 * declare const filter: Omit<EvmLogsFilter, "fromBlock" | "toBlock">
 * declare const cursor: bigint
 * declare const save: (block: bigint) => Effect.Effect<void>
 *
 * const program = Effect.gen(function*() {
 *   const indexer = yield* EvmIndexer
 *   // idle, wait 1 s, 2 s, 4 s... between head reads, at most 1 minute
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
 * {@link EvmIndexer.Service.streamLogs}. `logs` can be empty.
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
   * The logs matching `filter` from `fromBlock` on, one batch of at most `maxBlockRange` confirmed blocks at a time,
   * following the head: see the module's "Streaming" section.
   *
   * - `toBlock`: the stream ends after the batch reaching it. `fromBlock > toBlock` is an empty stream.
   * - `poll`: when to read the head again once caught up, defaults to `Schedule.spaced(DEFAULT_POLL_INTERVAL)`. A
   *   bounded schedule ends the stream when it is exhausted while still caught up.
   * - `retry`: retries a step failing with `Unavailable`, `InvalidResponse` or `Lagging` at the same block. Off by
   *   default: the first failure fails the stream.
   */
  readonly streamLogs: (options: {
    readonly filter: Omit<EvmRpc.EvmLogsFilter, "fromBlock" | "toBlock">
    readonly fromBlock: bigint
    readonly toBlock?: bigint | undefined
    // the schedule's output is ignored
    readonly poll?: Schedule.Schedule<unknown> | undefined
    // the schedule's output is ignored
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
 * The default spacing of the `poll` schedule of {@link EvmIndexer.Service.streamLogs}: the head is read again
 * every 10 seconds once caught up.
 *
 * @since 0.1.0
 * @category constants
 */
export const DEFAULT_POLL_INTERVAL: Duration.Duration = Duration.seconds(10)

// a stream's position: the next block to read and the confirmed head last read
interface Position {
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
          // one step from the next block to read: the head last read when it reaches `next` (the confirmed head
          // only moves forward), otherwise the head polled on `poll` until it does (an exhausted `poll` ends the
          // stream), then a batch up to it
          const step = (
            { head, next }: Position
          ): Effect.Effect<readonly [ReadonlyArray<EvmIndexerBatch>, Option.Option<Position>], EvmRpc.EvmRpcError> =>
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
              : (position) =>
                Effect.retry(step(position), { schedule: retry, while: (error) => JsonRpc.isTransient(error.reason) })
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
