/**
 * Reads the events of a contract and the STRK balance of an address, in fri, over confirmed blocks, on top of
 * {@link StarknetRpc}, once or as a stream following the confirmed head. The stream options are described in
 * [Concepts](https://github.com/spiko-tech/effect-blockchain/blob/main/docs/concepts.md#indexer-streams).
 *
 * An event range is split into ranges of at most `maxBlockRange` blocks, each paged with `starknet_getEvents`. A page
 * after a cursor is only served by the endpoint that issued the cursor, so when it fails the range restarts once from
 * its first page. Any other failure fails the whole call, and the caller retries the same range.
 *
 * @example
 * ```ts
 * import * as StarknetIndexer from "@effect-blockchain/starknet/StarknetIndexer"
 * import * as StarknetRpc from "@effect-blockchain/starknet/StarknetRpc"
 * import * as Config from "effect/Config"
 * import * as Effect from "effect/Effect"
 * import * as FetchHttpClient from "effect/http/FetchHttpClient"
 * import * as Layer from "effect/Layer"
 * import * as Stream from "effect/Stream"
 *
 * declare const filter: Omit<StarknetIndexer.StarknetIndexerFilter, "fromBlock" | "toBlock">
 * declare const cursor: bigint
 * declare const save: (block: bigint) => Effect.Effect<void>
 *
 * const program = Effect.gen(function*() {
 *   const rpc = yield* StarknetRpc.StarknetRpc
 *   const indexer = yield* StarknetIndexer.StarknetIndexer
 *   yield* Effect.log(`head: ${yield* rpc.blockNumber}`)
 *   yield* indexer.streamEvents({ filter, fromBlock: cursor + BigInt(1) }).pipe(
 *     Stream.runForEach((batch) => save(batch.toBlock))
 *   )
 * })
 *
 * const RpcLive = StarknetRpc.layerConfig({
 *   network: Config.succeed("Starknet"),
 *   endpoints: Config.all([Config.all({ name: Config.succeed("main"), url: Config.Redacted("STARKNET_RPC_URL") })])
 * })
 *
 * const main = program.pipe(
 *   Effect.provide(StarknetIndexer.layer().pipe(Layer.provideMerge(RpcLive), Layer.provide(FetchHttpClient.layer)))
 * )
 * ```
 *
 * @since 0.1.0
 */
import * as Confirmations from "@effect-blockchain/core/Confirmations"
import * as JsonRpc from "@effect-blockchain/core/JsonRpc"
import * as Arr from "effect/Array"
import * as BigInt_ from "effect/BigInt"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schedule from "effect/Schedule"
import * as Stream from "effect/Stream"
import type { StarknetAddress } from "./StarknetAddress.ts"
import type { StarknetEvent } from "./StarknetEvent.ts"
import * as StarknetNetwork from "./StarknetNetwork.ts"
import type { StarknetEventsCursor, StarknetEventsFilter } from "./StarknetRpc.ts"
import { StarknetRpc, StarknetRpcError } from "./StarknetRpc.ts"

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
 * size), so a range only bounds the work a restart redoes: 10000 blocks is a few hours of mainnet.
 *
 * @since 0.1.0
 * @category constants
 */
export const DEFAULT_MAX_BLOCK_RANGE = 10_000

/**
 * The {@link StarknetIndexer.Service.streamEvents} options. `toBlock`, `poll` and `retry` are described in
 * [Concepts](https://github.com/spiko-tech/effect-blockchain/blob/main/docs/concepts.md#indexer-streams).
 *
 * @since 0.1.0
 * @category models
 */
export interface StarknetIndexerStreamOptions {
  readonly filter: Omit<StarknetIndexerFilter, "fromBlock" | "toBlock">
  readonly fromBlock: bigint
  readonly toBlock?: bigint | undefined
  readonly poll?: Schedule.Schedule<unknown> | undefined
  readonly retry?: Schedule.Schedule<unknown, StarknetRpcError> | undefined
}

/**
 * The STRK balance of an address in fri at the end of `block`, emitted by
 * {@link StarknetIndexer.Service.streamNativeBalance}.
 *
 * @since 0.2.0
 * @category models
 */
export interface StarknetNativeBalance {
  readonly block: bigint
  readonly balance: bigint
}

/**
 * The {@link StarknetIndexer.Service.streamNativeBalance} options: one sample every `step` blocks from `fromBlock`.
 * `step` is a positive integer, `poll` and `retry` behave as in {@link StarknetIndexerStreamOptions}.
 *
 * @since 0.2.0
 * @category models
 */
export interface StarknetIndexerNativeBalanceOptions {
  readonly address: StarknetAddress
  readonly fromBlock: bigint
  readonly toBlock?: bigint | undefined
  readonly step: number
  readonly poll?: Schedule.Schedule<unknown> | undefined
  readonly retry?: Schedule.Schedule<unknown, StarknetRpcError> | undefined
}

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
  readonly streamEvents: (
    options: StarknetIndexerStreamOptions
  ) => Stream.Stream<StarknetIndexerBatch, StarknetRpcError>
  /** The STRK balance of `address` in fri at the end of `block`. A `block` above `lastConfirmedBlock` is accepted. */
  readonly fetchNativeBalance: (
    options: { readonly address: StarknetAddress; readonly block: bigint }
  ) => Effect.Effect<bigint, StarknetRpcError>
  /**
   * The STRK balance of `address` at `fromBlock`, `fromBlock + step`, `fromBlock + 2 * step`... one sample per step
   * even when unchanged, following the confirmed head.
   */
  readonly streamNativeBalance: (
    options: StarknetIndexerNativeBalanceOptions
  ) => Stream.Stream<StarknetNativeBalance, StarknetRpcError>
}>()("@effect-blockchain/starknet/StarknetIndexer") {}

/**
 * The default `poll` spacing of {@link StarknetIndexer.Service.streamEvents}: 10 seconds.
 *
 * @since 0.1.0
 * @category constants
 */
export const DEFAULT_POLL_INTERVAL: Duration.Duration = Confirmations.DEFAULT_POLL_INTERVAL

// sn_keccak("balanceOf"), the ERC-20 entry point selector
const BALANCE_OF = "0x02e4263afad30923c891518314c3c95dbe830a16874e8abc5777a9a20b54c76e"

// the confirmed blocks [next, head] not indexed yet, empty once the stream reaches the head it last read
interface StreamPosition {
  readonly next: bigint
  readonly head: bigint
}

/**
 * Builds a {@link StarknetIndexer} over the provided {@link StarknetRpc}.
 *
 * - `confirmations` defaults to {@link StarknetNetwork.defaultConfirmations} for the RPC's network.
 * - `maxBlockRange` is the largest range in blocks, a positive integer, default {@link DEFAULT_MAX_BLOCK_RANGE}.
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
      const size = BigInt(maxBlockRange)
      const confirmations = options.confirmations ?? StarknetNetwork.defaultConfirmations(rpc.network)
      const lastConfirmedBlock = rpc.blockNumber.pipe(
        Effect.map((head) => Confirmations.lastConfirmedBlock(head, confirmations)),
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
            const range = { ...filter, fromBlock, toBlock, chunkSize: options.chunkSize }
            // a cursor page has no fallback: when it fails, the range restarts once from its first page
            return Stream.paginate(
              Option.none<StarknetEventsCursor>(),
              (cursor) =>
                rpc.getEvents({ ...range, cursor: Option.getOrUndefined(cursor) }).pipe(Effect.mapBoth({
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
      // the head last read is reused while it covers `next` (the confirmed head only moves forward), else polled
      const confirmedFor = (next: bigint, head: bigint, poll: Schedule.Schedule<unknown>) =>
        next <= head
          ? Effect.succeed(head)
          : lastConfirmedBlock.pipe(Effect.repeat({ schedule: poll, until: (confirmed) => confirmed >= next }))
      const retrying = <A, S>(
        step: (state: S) => Effect.Effect<A, StarknetRpcError>,
        retry: Schedule.Schedule<unknown, StarknetRpcError> | undefined
      ) =>
        retry === undefined
          ? step
          : (state: S) =>
            Effect.retry(step(state), { schedule: retry, while: (error) => JsonRpc.isTransient(error.reason) })
      const fetchNativeBalance = Effect.fn("StarknetIndexer.fetchNativeBalance")(
        ({ address, block }: { readonly address: StarknetAddress; readonly block: bigint }) =>
          rpc.call({
            contractAddress: StarknetNetwork.STRK_TOKEN_ADDRESS,
            entryPointSelector: BALANCE_OF,
            calldata: [address],
            blockNumber: block
          }).pipe(Effect.flatMap((felts) =>
            felts.length === 2
              ? Effect.succeed(BigInt(felts[0]) + (BigInt(felts[1]) << BigInt(128)))
              : Effect.fail(
                new StarknetRpcError({
                  reason: new JsonRpc.InvalidResponse(),
                  method: "starknet_call",
                  endpoint: "StarknetIndexer",
                  cause: new Error(`balanceOf returned ${felts.length} felts, expected a u256 (low, high)`)
                })
              )
          ))
      )
      return StarknetIndexer.of({
        lastConfirmedBlock,
        fetchEvents,
        fetchNativeBalance,
        streamNativeBalance: (
          { address, fromBlock, poll = Schedule.spaced(DEFAULT_POLL_INTERVAL), retry, step, toBlock }
        ) => {
          if (!Number.isSafeInteger(step) || step < 1) {
            return Stream.die(new RangeError(`step must be a positive integer, got ${step}`))
          }
          if (toBlock !== undefined && fromBlock > toBlock) return Stream.empty
          const size = BigInt(step)
          const sample = (
            { head, next }: StreamPosition
          ): Effect.Effect<
            readonly [ReadonlyArray<StarknetNativeBalance>, Option.Option<StreamPosition>],
            StarknetRpcError
          > =>
            confirmedFor(next, head, poll).pipe(Effect.flatMap((confirmed) => {
              if (next > confirmed) return Effect.succeed([[], Option.none()])
              return fetchNativeBalance({ address, block: next }).pipe(Effect.map((balance) => [
                [{ block: next, balance }],
                toBlock !== undefined && next + size > toBlock
                  ? Option.none()
                  : Option.some({ next: next + size, head: confirmed })
              ]))
            }))
          return Stream.paginate({ next: fromBlock, head: fromBlock - BigInt(1) }, retrying(sample, retry))
        },
        streamEvents: ({ filter, fromBlock, poll = Schedule.spaced(DEFAULT_POLL_INTERVAL), retry, toBlock }) => {
          if (toBlock !== undefined && fromBlock > toBlock) return Stream.empty
          const step = (
            { head, next }: StreamPosition
          ): Effect.Effect<
            readonly [ReadonlyArray<StarknetIndexerBatch>, Option.Option<StreamPosition>],
            StarknetRpcError
          > =>
            confirmedFor(next, head, poll).pipe(Effect.flatMap((confirmed) => {
              const cap = toBlock === undefined ? confirmed : BigInt_.min(confirmed, toBlock)
              if (next > cap) return Effect.succeed([[], Option.none()])
              const end = BigInt_.min(next + size - BigInt(1), cap)
              return fetchEvents({ ...filter, fromBlock: next, toBlock: end }).pipe(Effect.map((events) => [
                [{ fromBlock: next, toBlock: end, events }],
                end === toBlock ? Option.none() : Option.some({ next: end + BigInt(1), head: confirmed })
              ]))
            }))
          // a head below `fromBlock`: the first step reads it
          return Stream.paginate({ next: fromBlock, head: fromBlock - BigInt(1) }, retrying(step, retry))
        }
      })
    })
  )

/**
 * Builds a {@link StarknetIndexer} like {@link layer}, reading the options from `Config`.
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
