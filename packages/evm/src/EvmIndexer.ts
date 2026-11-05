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
 * `streamLogs` follows the confirmed head from `fromBlock`: each step reads `lastConfirmedBlock` and fetches the next
 * `maxBlockRange` blocks at most, up to it, as one {@link EvmIndexerBatch}. A batch is emitted even when it has no
 * logs, so the caller's cursor moves on a quiet contract. Caught up, the stream sleeps `pollInterval` and checks
 * again; with a `toBlock` it ends after the batch reaching it. With `retry`, a step failing with a transient reason
 * (`Unavailable`, `InvalidResponse`, `Lagging`) is retried at the same block; any other failure, or an exhausted
 * schedule, fails the stream. Delivery is at-least-once: save `batch.toBlock` after handling a batch and restart
 * from the block after it. Run one stream per (network, filter) at a time: the indexer does not coordinate processes,
 * so a service with several replicas provides the exclusivity itself, for example with a Postgres advisory lock.
 *
 * ```ts
 * import * as Effect from "effect/Effect"
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
 *   yield* indexer.streamLogs({ filter, fromBlock: cursor + BigInt(1) }).pipe(
 *     Stream.runForEach((batch) => save(batch.toBlock))
 *   )
 * })
 * ```
 *
 * @since 0.1.0
 */
import * as Arr from "effect/Array"
import * as BigInt_ from "effect/BigInt"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import type * as Schedule from "effect/Schedule"
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
   * - `pollInterval`: the wait once caught up, defaults to {@link DEFAULT_POLL_INTERVAL}.
   * - `retry`: retries a step failing with `Unavailable`, `InvalidResponse` or `Lagging` at the same block. Off by
   *   default: the first failure fails the stream.
   */
  readonly streamLogs: (options: {
    readonly filter: Omit<EvmRpc.EvmLogsFilter, "fromBlock" | "toBlock">
    readonly fromBlock: bigint
    readonly toBlock?: bigint | undefined
    readonly pollInterval?: Duration.Input | undefined
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
 * The default `pollInterval` of {@link EvmIndexer.Service.streamLogs}: the wait before reading the head again once
 * caught up.
 *
 * @since 0.1.0
 * @category constants
 */
export const DEFAULT_POLL_INTERVAL: Duration.Duration = Duration.seconds(10)

// the reasons a later attempt can fix: the others answer the same at the same block
const isTransient = (error: EvmRpc.EvmRpcError): boolean =>
  error.reason === "Unavailable" || error.reason === "InvalidResponse" || error.reason === "Lagging"

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
        streamLogs: ({ filter, fromBlock, pollInterval = DEFAULT_POLL_INTERVAL, retry, toBlock }) => {
          if (toBlock !== undefined && fromBlock > toBlock) return Stream.empty
          // one step from the next block to read: a batch up to the confirmed head, or a sleep once caught up
          const step = (
            next: bigint
          ): Effect.Effect<readonly [ReadonlyArray<EvmIndexerBatch>, Option.Option<bigint>], EvmRpc.EvmRpcError> =>
            lastConfirmedBlock.pipe(
              Effect.flatMap((confirmed) => {
                const cap = toBlock === undefined ? confirmed : BigInt_.min(confirmed, toBlock)
                if (next > cap) return Effect.as(Effect.sleep(pollInterval), [[], Option.some(next)])
                const end = BigInt_.min(next + size - BigInt(1), cap)
                return fetchLogs({ ...filter, fromBlock: next, toBlock: end }).pipe(Effect.map((logs) => [
                  [{ fromBlock: next, toBlock: end, logs }],
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
