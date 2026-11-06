/**
 * EVM indexing on top of {@link EvmRpc.EvmRpc}: the last confirmed block, the logs of a set of contracts over a block
 * range, the native balance of an address at a block, and streams of both following the confirmed head.
 *
 * A range is split into ranges of at most `maxBlockRange` blocks, one `eth_getLogs` after another. A failing range
 * fails the whole call and drops the logs already read: the caller retries the same range. A balance is one
 * `eth_getBalance` per sample.
 *
 * @example
 * ```ts
 * import type { EvmIndexerFilter } from "@effect-blockchain/evm/EvmIndexer"
 * import { EvmIndexer } from "@effect-blockchain/evm/EvmIndexer"
 * import * as Effect from "effect/Effect"
 * import * as Schedule from "effect/Schedule"
 * import * as Stream from "effect/Stream"
 *
 * declare const filter: Omit<EvmIndexerFilter, "fromBlock" | "toBlock">
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
 * @example
 * ```ts
 * import type { EvmAddress } from "@effect-blockchain/evm/EvmAddress"
 * import { EvmIndexer } from "@effect-blockchain/evm/EvmIndexer"
 * import * as Effect from "effect/Effect"
 * import * as Stream from "effect/Stream"
 *
 * declare const address: EvmAddress
 *
 * // the balance in wei every 7200 blocks (about a day on Ethereum) up to the head, then every new 7200 blocks
 * const daily = Effect.gen(function*() {
 *   const indexer = yield* EvmIndexer
 *   return indexer.streamNativeBalance({ address, fromBlock: BigInt(21_000_000), step: 7200 }).pipe(
 *     Stream.tap(({ balance, block }) => Effect.log(`${block}: ${balance} wei`))
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
import type { EvmAddress } from "./EvmAddress.ts"
import type { EvmLog } from "./EvmLog.ts"
import * as EvmNetwork from "./EvmNetwork.ts"
import * as EvmRpc from "./EvmRpc.ts"

/**
 * A {@link EvmIndexer} `fetchLogs` filter: an `eth_getLogs` filter over the inclusive block range
 * `[fromBlock, toBlock]`.
 *
 * @since 0.1.0
 * @category models
 */
export type EvmIndexerFilter = EvmRpc.EvmLogsFilter

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
 * The {@link EvmIndexer.Service.streamLogs} options.
 *
 * @since 0.1.0
 * @category models
 */
export interface EvmIndexerStreamOptions {
  readonly filter: Omit<EvmIndexerFilter, "fromBlock" | "toBlock">
  readonly fromBlock: bigint
  /** The stream ends after the batch reaching it, and is empty when `fromBlock > toBlock`. */
  readonly toBlock?: bigint | undefined
  /**
   * When to read the head again once caught up, `Schedule.spaced(DEFAULT_POLL_INTERVAL)` by default. It restarts after
   * each batch, and its end ends the stream: `Schedule.recurs(0)` drains to the head and stops.
   */
  readonly poll?: Schedule.Schedule<unknown> | undefined
  /** Retries a step failing with a transient reason ({@link JsonRpc.isTransient}) at the same block. Off by default. */
  readonly retry?: Schedule.Schedule<unknown, EvmRpc.EvmRpcError> | undefined
}

/**
 * The native balance of an address in wei at the end of `block`, emitted by
 * {@link EvmIndexer.Service.streamNativeBalance}.
 *
 * @since 0.3.0
 * @category models
 */
export interface EvmNativeBalance {
  readonly block: bigint
  readonly balance: bigint
}

/**
 * The {@link EvmIndexer.Service.streamNativeBalance} options: one sample at `fromBlock`, then every `step` blocks.
 * `step` is a positive safe integer, `poll` and `retry` work as in {@link EvmIndexerStreamOptions}.
 *
 * @since 0.3.0
 * @category models
 */
export interface EvmIndexerNativeBalanceOptions {
  readonly address: EvmAddress
  readonly fromBlock: bigint
  /** The stream ends after the last sample not above it, and is empty when `fromBlock > toBlock`. */
  readonly toBlock?: bigint | undefined
  readonly step: number
  readonly poll?: Schedule.Schedule<unknown> | undefined
  readonly retry?: Schedule.Schedule<unknown, EvmRpc.EvmRpcError> | undefined
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
  readonly fetchLogs: (filter: EvmIndexerFilter) => Effect.Effect<ReadonlyArray<EvmLog>, EvmRpc.EvmRpcError>
  /**
   * The logs matching `filter` from `fromBlock` on, in batches of at most `maxBlockRange` confirmed blocks, following
   * the confirmed head.
   */
  readonly streamLogs: (options: EvmIndexerStreamOptions) => Stream.Stream<EvmIndexerBatch, EvmRpc.EvmRpcError>
  /**
   * The native balance of `address` in wei at the end of `block`, which needs an archive endpoint for an old block.
   *
   * @since 0.3.0
   */
  readonly fetchNativeBalance: (options: {
    readonly address: EvmAddress
    readonly block: bigint
  }) => Effect.Effect<bigint, EvmRpc.EvmRpcError>
  /**
   * The native balance of `address` at `fromBlock`, `fromBlock + step`, ... (a sample at every step, changed or not),
   * each read once its block is confirmed, following the confirmed head.
   *
   * @since 0.3.0
   */
  readonly streamNativeBalance: (
    options: EvmIndexerNativeBalanceOptions
  ) => Stream.Stream<EvmNativeBalance, EvmRpc.EvmRpcError>
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
interface StreamPosition {
  readonly next: bigint
  readonly head: bigint
}

type Page<A> = readonly [ReadonlyArray<A>, Option.Option<StreamPosition>]

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
      // the head last read is reused while it covers `next` (the confirmed head only moves forward), else polled
      const confirmedHead = (poll: Schedule.Schedule<unknown>, { head, next }: StreamPosition) =>
        next <= head
          ? Effect.succeed(head)
          : lastConfirmedBlock.pipe(Effect.repeat({ schedule: poll, until: (confirmed) => confirmed >= next }))
      const paginate = <A>(
        start: bigint,
        retry: Schedule.Schedule<unknown, EvmRpc.EvmRpcError> | undefined,
        step: (position: StreamPosition) => Effect.Effect<Page<A>, EvmRpc.EvmRpcError>
      ) =>
        Stream.paginate(
          // a head below `start`: the first step reads it
          { next: start, head: start - BigInt(1) },
          retry === undefined
            ? step
            : (position) =>
              Effect.retry(step(position), { schedule: retry, while: (error) => JsonRpc.isTransient(error.reason) })
        )
      const fetchLogs = Effect.fn("EvmIndexer.fetchLogs")((filter: EvmIndexerFilter) => {
        if (filter.fromBlock > filter.toBlock) return Effect.succeed([])
        const count = Number((filter.toBlock - filter.fromBlock) / size) + 1
        return Effect.forEach(
          Arr.makeBy(count, (i) => filter.fromBlock + BigInt(i) * size),
          (fromBlock) =>
            rpc.getLogs({ ...filter, fromBlock, toBlock: BigInt_.min(fromBlock + size - BigInt(1), filter.toBlock) })
        ).pipe(Effect.map(Arr.flatten))
      })
      const fetchNativeBalance = Effect.fn("EvmIndexer.fetchNativeBalance")(
        ({ address, block }: { readonly address: EvmAddress; readonly block: bigint }) =>
          rpc.getBalance({ address, blockNumber: block })
      )
      return EvmIndexer.of({
        lastConfirmedBlock,
        fetchLogs,
        streamLogs: ({ filter, fromBlock, poll = Schedule.spaced(DEFAULT_POLL_INTERVAL), retry, toBlock }) => {
          if (toBlock !== undefined && fromBlock > toBlock) return Stream.empty
          return paginate(fromBlock, retry, (position) =>
            confirmedHead(poll, position).pipe(Effect.flatMap((confirmed) => {
              const { next } = position
              const cap = toBlock === undefined ? confirmed : BigInt_.min(confirmed, toBlock)
              if (next > cap) {
                return Effect.succeed<Page<EvmIndexerBatch>>([[], Option.none()])
              }
              const end = BigInt_.min(next + size - BigInt(1), cap)
              return fetchLogs({ ...filter, fromBlock: next, toBlock: end }).pipe(Effect.map((logs) =>
                [
                  [{ fromBlock: next, toBlock: end, logs }],
                  end === toBlock ? Option.none() : Option.some({ next: end + BigInt(1), head: confirmed })
                ] as const
              ))
            })))
        },
        fetchNativeBalance,
        streamNativeBalance: (
          { address, fromBlock, poll = Schedule.spaced(DEFAULT_POLL_INTERVAL), retry, step, toBlock }
        ) => {
          if (!Number.isSafeInteger(step) || step < 1) {
            return Stream.die(new RangeError(`step must be a positive safe integer, got ${step}`))
          }
          if (toBlock !== undefined && fromBlock > toBlock) {
            return Stream.empty
          }
          const stride = BigInt(step)
          return paginate(fromBlock, retry, (position) =>
            confirmedHead(poll, position).pipe(Effect.flatMap((confirmed) => {
              const block = position.next
              if (block > confirmed) {
                return Effect.succeed<Page<EvmNativeBalance>>([[], Option.none()])
              }
              const next = block + stride
              return fetchNativeBalance({ address, block }).pipe(Effect.map((balance) =>
                [
                  [{ block, balance }],
                  toBlock !== undefined && next > toBlock ? Option.none() : Option.some({ next, head: confirmed })
                ] as const
              ))
            })))
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
