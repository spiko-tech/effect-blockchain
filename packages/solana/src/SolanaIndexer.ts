/**
 * Solana transaction indexing on top of {@link SolanaRpc}: the last confirmed slot, the transactions touching an
 * address over a slot range, its lamport balance at a slot, and streams of both following the confirmed head. Blocks
 * are slots.
 *
 * Everything is read at `finalized` commitment. `getSignaturesForAddress` has no slot range, so a range is paged from
 * the head backwards until it passes `fromBlock`: the cost grows with the address's history since `fromBlock`, then
 * each transaction costs one `getTransaction`. Each page sends `minContextSlot: toBlock`, so a lagging endpoint that
 * honours it falls back. Any failure fails the whole call and nothing is returned: the caller retries the same range.
 *
 * @example
 * ```ts
 * import type { SolanaAddress } from "@effect-blockchain/solana/SolanaAddress"
 * import type { SolanaIndexerFilter } from "@effect-blockchain/solana/SolanaIndexer"
 * import { SolanaIndexer } from "@effect-blockchain/solana/SolanaIndexer"
 * import * as Effect from "effect/Effect"
 * import * as Schedule from "effect/Schedule"
 * import * as Stream from "effect/Stream"
 *
 * declare const filter: Omit<SolanaIndexerFilter, "fromBlock" | "toBlock">
 * declare const cursor: bigint
 * declare const save: (slot: bigint) => Effect.Effect<void>
 *
 * const program = Effect.gen(function*() {
 *   const indexer = yield* SolanaIndexer
 *   // once caught up, read the head after 1 s, 2 s, 4 s... at most every minute
 *   const poll = Schedule.min([Schedule.exponential("1 second"), Schedule.spaced("1 minute")])
 *   yield* indexer.streamTransactions({ filter, fromBlock: cursor + BigInt(1), poll }).pipe(
 *     Stream.runForEach((batch) => save(batch.toBlock))
 *   )
 * })
 *
 * declare const address: SolanaAddress
 *
 * // the lamports of `address` every 9000 slots (about an hour) from slot 400000000
 * const balances = Effect.gen(function*() {
 *   const indexer = yield* SolanaIndexer
 *   yield* indexer.streamNativeBalance({ address, fromBlock: BigInt(400000000), step: 9000 }).pipe(
 *     Stream.runForEach(({ balance, block }) => Effect.log(`${block}: ${balance}`))
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
import type * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import type { SolanaAddress } from "./SolanaAddress.ts"
import * as SolanaNetwork from "./SolanaNetwork.ts"
import type { SolanaSignatureInfo, SolanaTransactionEncoding, SolanaTransactionInfo } from "./SolanaRpc.ts"
import { balanceChange, SolanaRpc, SolanaRpcError } from "./SolanaRpc.ts"
import type { SolanaTransactionHash } from "./SolanaTransactionHash.ts"

/**
 * A transaction touching the indexed address, kept raw: the `getTransaction` result with its `signature` and the
 * `err` listed by `getSignaturesForAddress` (raw JSON, `null` when it succeeded). Failed transactions are kept: they
 * still paid their fee. `transaction` follows the requested encoding.
 *
 * @since 0.1.0
 * @category models
 */
export interface SolanaIndexedTransaction<Encoding extends SolanaTransactionEncoding = "base64">
  extends SolanaTransactionInfo<Encoding>
{
  readonly signature: SolanaTransactionHash
  readonly err: Schema.Json
}

/**
 * A {@link SolanaIndexer} `fetchTransactions` filter: the address whose transactions are read, over the inclusive slot
 * range `[fromBlock, toBlock]`.
 *
 * @since 0.1.0
 * @category models
 */
export interface SolanaIndexerFilter {
  readonly address: SolanaAddress
  readonly fromBlock: bigint
  readonly toBlock: bigint
}

/**
 * The transactions of slots `[fromBlock, toBlock]` (both inclusive), in chain order, emitted by
 * {@link SolanaIndexer.Service.streamTransactions}.
 *
 * A batch is emitted for every range, even without transactions. Delivery is at-least-once: save `batch.toBlock` once
 * the batch is handled and resume from `toBlock + 1`. A batch holds at most `maxBatchSize` transactions, more when a
 * single slot has more, as a slot is never split.
 *
 * @since 0.1.0
 * @category models
 */
export interface SolanaIndexerBatch<Encoding extends SolanaTransactionEncoding = "base64"> {
  readonly fromBlock: bigint
  readonly toBlock: bigint
  readonly transactions: ReadonlyArray<SolanaIndexedTransaction<Encoding>>
}

/**
 * The {@link SolanaIndexer.Service.streamTransactions} options, `encoding` aside.
 *
 * @since 0.1.0
 * @category models
 */
export interface SolanaIndexerStreamOptions {
  readonly filter: Omit<SolanaIndexerFilter, "fromBlock" | "toBlock">
  readonly fromBlock: bigint
  /** The stream ends after the batch reaching it, and is empty when `fromBlock > toBlock`. */
  readonly toBlock?: bigint | undefined
  /**
   * When to read the head again once caught up, `Schedule.spaced(DEFAULT_POLL_INTERVAL)` by default. It restarts after
   * each batch, and its end ends the stream: `Schedule.recurs(0)` drains to the head and stops.
   */
  readonly poll?: Schedule.Schedule<unknown> | undefined
  /**
   * Retries a step (the signature paging or one batch's transactions) failing with a transient reason
   * ({@link JsonRpc.isTransient}) at the same position. Off by default.
   */
  readonly retry?: Schedule.Schedule<unknown, SolanaRpcError> | undefined
}

/**
 * The lamports of an address at the end of slot `block`, emitted by {@link SolanaIndexer.Service.streamNativeBalance}.
 *
 * @since 0.2.0
 * @category models
 */
export interface SolanaNativeBalance {
  readonly block: bigint
  readonly balance: bigint
}

/**
 * The {@link SolanaIndexer.Service.streamNativeBalance} options: a sample of the balance of `address` at `fromBlock`,
 * `fromBlock + step`, `fromBlock + 2 * step`... `poll` and `retry` behave as in {@link SolanaIndexerStreamOptions}.
 *
 * @since 0.2.0
 * @category models
 */
export interface SolanaIndexerNativeBalanceOptions {
  readonly address: SolanaAddress
  readonly fromBlock: bigint
  /** The stream ends after the last sample not above it, and is empty when `fromBlock > toBlock`. */
  readonly toBlock?: bigint | undefined
  /** The slots between two samples, a positive safe integer. */
  readonly step: number
  readonly poll?: Schedule.Schedule<unknown> | undefined
  readonly retry?: Schedule.Schedule<unknown, SolanaRpcError> | undefined
}

/**
 * @since 0.1.0
 * @category services
 */
export class SolanaIndexer extends Context.Service<SolanaIndexer, {
  /** The `finalized` slot minus the confirmations, never below 0. */
  readonly lastConfirmedBlock: Effect.Effect<bigint, SolanaRpcError>
  /**
   * The transactions touching `address` in slots `fromBlock..toBlock` (both inclusive), in chain order. Empty when
   * `fromBlock > toBlock`. `encoding` defaults to `base64`.
   */
  readonly fetchTransactions: {
    (
      filter: SolanaIndexerFilter,
      options?: { readonly encoding?: "base64" | undefined }
    ): Effect.Effect<ReadonlyArray<SolanaIndexedTransaction>, SolanaRpcError>
    <Encoding extends SolanaTransactionEncoding>(
      filter: SolanaIndexerFilter,
      options: { readonly encoding: Encoding }
    ): Effect.Effect<ReadonlyArray<SolanaIndexedTransaction<Encoding>>, SolanaRpcError>
  }
  /**
   * The transactions touching `filter.address` from slot `fromBlock` on, in batches of at most `maxBatchSize`
   * signatures, following the confirmed head. `encoding` defaults to `base64`.
   */
  readonly streamTransactions: {
    (
      options: SolanaIndexerStreamOptions & { readonly encoding?: "base64" | undefined }
    ): Stream.Stream<SolanaIndexerBatch, SolanaRpcError>
    <Encoding extends SolanaTransactionEncoding>(
      options: SolanaIndexerStreamOptions & { readonly encoding: Encoding }
    ): Stream.Stream<SolanaIndexerBatch<Encoding>, SolanaRpcError>
  }
  /**
   * The lamports of `address` at the end of slot `block`: the `postBalances` of its newest transaction at or before
   * `block`, else the `preBalances` of its first one after. At or above the confirmed head with no newer transaction,
   * its `getBalance`: an address without any transaction reads its current balance there and 0 below.
   */
  readonly fetchNativeBalance: (options: {
    readonly address: SolanaAddress
    readonly block: bigint
  }) => Effect.Effect<bigint, SolanaRpcError>
  /**
   * The lamports of `address` at every `step` slots from `fromBlock`, following the confirmed head. A sample only
   * reads the meta of the newest transaction since the previous one, so epoch rewards, which change a balance without
   * a transaction, show from the next transaction on.
   */
  readonly streamNativeBalance: (
    options: SolanaIndexerNativeBalanceOptions
  ) => Stream.Stream<SolanaNativeBalance, SolanaRpcError>
}>()("@effect-blockchain/solana/SolanaIndexer") {}

// the node's maximum `limit`
const PAGE_SIZE = 1000
const COMMITMENT = "finalized"

/**
 * The default `maxBatchSize`: each signature costs one sequential `getTransaction`, so 100 keeps a batch to a few
 * dozen seconds of calls and about 100 transactions in memory between two saved cursors.
 *
 * @since 0.1.0
 * @category constants
 */
export const DEFAULT_MAX_BATCH_SIZE = 100

/**
 * The default `poll` spacing of {@link SolanaIndexer.Service.streamTransactions}: 10 seconds.
 *
 * @since 0.1.0
 * @category constants
 */
export const DEFAULT_POLL_INTERVAL: Duration.Duration = Duration.seconds(10)

// consecutive groups of at most `max` signatures, a slot never split: a full group still takes its last slot's others
const groupBySlot = (
  signatures: ReadonlyArray<SolanaSignatureInfo>,
  max: number
): Array<Arr.NonEmptyArray<SolanaSignatureInfo>> => {
  const groups: Array<Arr.NonEmptyArray<SolanaSignatureInfo>> = []
  for (const info of signatures) {
    const last = groups.at(-1)
    if (last !== undefined && (last.length < max || Arr.lastNonEmpty(last).slot === info.slot)) last.push(info)
    else groups.push([info])
  }
  return groups
}

// a stream position: the next slot to emit, then either nothing pending (read the head and page the signatures) or
// the groups of `[next, cap]` still to fetch, one per step
interface StreamPosition {
  readonly next: bigint
  readonly cap: bigint
  readonly groups: ReadonlyArray<Arr.NonEmptyReadonlyArray<SolanaSignatureInfo>>
}
// a sample, then the next stream position: the previous sample, none for the first
type Sample = readonly [ReadonlyArray<SolanaNativeBalance>, Option.Option<Option.Option<SolanaNativeBalance>>]
type Step = readonly [ReadonlyArray<SolanaIndexerBatch<SolanaTransactionEncoding>>, Option.Option<StreamPosition>]

// retries a stream step failing with a transient reason at the same position
const withRetry = <S, A>(
  retry: Schedule.Schedule<unknown, SolanaRpcError> | undefined,
  step: (position: S) => Effect.Effect<A, SolanaRpcError>
) =>
  retry === undefined
    ? step
    : (position: S) =>
      Effect.retry(step(position), { schedule: retry, while: (error) => JsonRpc.isTransient(error.reason) })

/**
 * Builds a {@link SolanaIndexer} on the provided {@link SolanaRpc}.
 *
 * - `confirmations` defaults to {@link SolanaNetwork.defaultConfirmations} for the RPC's network.
 * - `maxBatchSize`, a positive integer, the signatures per `streamTransactions` batch, defaults to
 *   {@link DEFAULT_MAX_BATCH_SIZE}.
 *
 * There is no `maxBlockRange`: `getSignaturesForAddress` takes no slot range to split.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer = (options: {
  readonly confirmations?: number | undefined
  readonly maxBatchSize?: number | undefined
} = {}): Layer.Layer<SolanaIndexer, never, SolanaRpc> =>
  Layer.effect(
    SolanaIndexer,
    Effect.gen(function*() {
      const rpc = yield* SolanaRpc
      const maxBatchSize = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE
      if (!Number.isSafeInteger(maxBatchSize) || maxBatchSize < 1) {
        return yield* Effect.die(new RangeError(`maxBatchSize must be a positive integer, got ${maxBatchSize}`))
      }
      const confirmations = BigInt(options.confirmations ?? SolanaNetwork.defaultConfirmations(rpc.network))
      const lastConfirmedBlock = rpc.getSlot({ commitment: COMMITMENT }).pipe(
        Effect.map((slot) => BigInt_.max(slot - confirmations, BigInt(0))),
        Effect.withSpan("SolanaIndexer.lastConfirmedBlock")
      )
      // the signatures of `address`, newest first, a page read only when the previous one is consumed
      const signatures = (address: SolanaAddress, minContextSlot: bigint) =>
        Stream.paginate(
          Option.none<SolanaTransactionHash>(),
          (before) =>
            rpc.getSignaturesForAddress({
              address,
              before: Option.getOrUndefined(before),
              limit: PAGE_SIZE,
              commitment: COMMITMENT,
              minContextSlot
            }).pipe(Effect.map((page) => {
              const last = page.at(-1)
              return [
                page,
                last === undefined || page.length < PAGE_SIZE ? Option.none() : Option.some(Option.some(last.signature))
              ] as const
            }))
        )
      // the signatures of `[fromBlock, toBlock]` in chain order, paged from the head back to the first short page or
      // the first page reaching below `fromBlock`
      const fetchSignatures = (filter: SolanaIndexerFilter) =>
        signatures(filter.address, filter.toBlock).pipe(
          Stream.takeWhile(({ slot }) => slot >= filter.fromBlock),
          Stream.runCollect,
          // newest first, so reversed slots ascend. The order within a slot is undocumented: reversing it is a best
          // guess at execution order (`transactionIndex`, which some providers add, is not in the RPC model)
          Effect.map((signatures) => Arr.reverse(Arr.filter(signatures, ({ slot }) => slot <= filter.toBlock)))
        )
      const fetchEach = (signatures: ReadonlyArray<SolanaSignatureInfo>, encoding: SolanaTransactionEncoding) =>
        Effect.forEach(signatures, ({ err, signature }) =>
          rpc.getTransaction({ signature, commitment: COMMITMENT, encoding }).pipe(
            Effect.map((tx) => ({ signature, err, ...tx }))
          ))
      const fetchRange = Effect.fn("SolanaIndexer.fetchTransactions")(
        function*(filter: SolanaIndexerFilter, encoding: SolanaTransactionEncoding) {
          if (filter.fromBlock > filter.toBlock) {
            return []
          }
          return yield* fetchEach(yield* fetchSignatures(filter), encoding)
        }
      )

      function fetchTransactions(
        filter: SolanaIndexerFilter,
        options?: { readonly encoding?: "base64" | undefined }
      ): Effect.Effect<ReadonlyArray<SolanaIndexedTransaction>, SolanaRpcError>
      function fetchTransactions<Encoding extends SolanaTransactionEncoding>(
        filter: SolanaIndexerFilter,
        options: { readonly encoding: Encoding }
      ): Effect.Effect<ReadonlyArray<SolanaIndexedTransaction<Encoding>>, SolanaRpcError>
      function fetchTransactions(
        filter: SolanaIndexerFilter,
        { encoding = "base64" }: { readonly encoding?: SolanaTransactionEncoding | undefined } = {}
      ): Effect.Effect<ReadonlyArray<SolanaIndexedTransaction<SolanaTransactionEncoding>>, SolanaRpcError> {
        return fetchRange(filter, encoding)
      }

      function streamTransactions(
        options: SolanaIndexerStreamOptions & { readonly encoding?: "base64" | undefined }
      ): Stream.Stream<SolanaIndexerBatch, SolanaRpcError>
      function streamTransactions<Encoding extends SolanaTransactionEncoding>(
        options: SolanaIndexerStreamOptions & { readonly encoding: Encoding }
      ): Stream.Stream<SolanaIndexerBatch<Encoding>, SolanaRpcError>
      function streamTransactions(
        options: SolanaIndexerStreamOptions & { readonly encoding?: SolanaTransactionEncoding | undefined }
      ): Stream.Stream<SolanaIndexerBatch<SolanaTransactionEncoding>, SolanaRpcError> {
        const { encoding = "base64", filter, fromBlock, retry, toBlock } = options
        const poll = options.poll ?? Schedule.spaced(DEFAULT_POLL_INTERVAL)
        if (toBlock !== undefined && fromBlock > toBlock) {
          return Stream.empty
        }
        const after = (end: bigint, cap: bigint, groups: StreamPosition["groups"]): Option.Option<StreamPosition> =>
          end === toBlock ? Option.none() : Option.some({ next: end + BigInt(1), cap, groups })
        // one step: the transactions of the next pending group, else the signatures up to the polled confirmed head
        const step = (position: StreamPosition): Effect.Effect<Step, SolanaRpcError> => {
          const { cap, groups, next } = position
          if (Arr.isReadonlyArrayNonEmpty(groups)) {
            const [group, ...rest] = groups
            const end = rest.length === 0 ? cap : Arr.lastNonEmpty(group).slot
            return fetchEach(group, encoding).pipe(
              Effect.map((transactions): Step => [
                [{ fromBlock: next, toBlock: end, transactions }],
                after(end, cap, rest)
              ]),
              Effect.withSpan("SolanaIndexer.streamTransactions.fetchGroup")
            )
          }
          return lastConfirmedBlock.pipe(
            Effect.repeat({
              schedule: poll,
              until: (confirmed) =>
                confirmed >= next
            }),
            Effect.flatMap((confirmed) => {
              const end = toBlock === undefined ? confirmed : BigInt_.min(confirmed, toBlock)
              if (next > end) {
                return Effect.succeed([[], Option.none()] as const)
              }
              return fetchSignatures({ address: filter.address, fromBlock: next, toBlock: end }).pipe(
                Effect.map((signatures): Step =>
                  Arr.isReadonlyArrayNonEmpty(signatures)
                    ? [[], Option.some({ next, cap: end, groups: groupBySlot(signatures, maxBatchSize) })]
                    : [[{ fromBlock: next, toBlock: end, transactions: [] }], after(end, end, [])]
                ),
                Effect.withSpan("SolanaIndexer.streamTransactions.fetchSignatures")
              )
            })
          )
        }
        return Stream.paginate(
          { next: fromBlock, cap: fromBlock, groups: [] } satisfies StreamPosition,
          withRetry(retry, step)
        )
      }

      const balanceOf = (address: SolanaAddress, signature: SolanaTransactionHash, side: "pre" | "post") =>
        rpc.getTransaction({ signature, commitment: COMMITMENT, encoding: "json" }).pipe(
          Effect.flatMap((tx) =>
            Option.match(balanceChange(tx, address), {
              onSome: (change) =>
                Effect.succeed(change[side]),
              onNone: () =>
                Effect.fail(
                  new SolanaRpcError({
                    reason: new JsonRpc.InvalidResponse(),
                    method: "getTransaction",
                    endpoint: "SolanaIndexer",
                    cause: new Error(`transaction ${signature} has no balance for ${address}`)
                  })
                )
            })
          )
        )
      // the balance at the end of `block`, at or below `confirmed`, given the sample before it when there is one
      const balanceAt = Effect.fnUntraced(function*(
        address: SolanaAddress,
        block: bigint,
        confirmed: bigint,
        previous: Option.Option<SolanaNativeBalance>
      ): Effect.fn.Return<bigint, SolanaRpcError> {
        // read before the signatures, so that a transaction landing in between is listed
        const current = Option.isNone(previous) && block >= confirmed
          ? Option.some(yield* rpc.getBalance({ address }))
          : Option.none()
        // the newest signature, and the newest at or before `block` or else the oldest
        const { last, newest } = yield* signatures(address, BigInt_.min(block, confirmed)).pipe(
          Stream.takeUntil(({ slot }) => slot <= block),
          Stream.runFold(
            () => ({ newest: Option.none<SolanaSignatureInfo>(), last: Option.none<SolanaSignatureInfo>() }),
            (acc, info) => ({ newest: Option.orElseSome(acc.newest, () => info), last: Option.some(info) })
          )
        )
        if (
          Option.isSome(current) &&
          Option.match(newest, {
            onNone: () => true,
            onSome: ({ slot }) => slot <= BigInt_.min(block, current.value.slot)
          })
        ) {
          return current.value.value
        }
        if (Option.isSome(last) && last.value.slot <= block) {
          return Option.isSome(previous) && last.value.slot <= previous.value.block
            ? previous.value.balance
            : yield* balanceOf(address, last.value.signature, "post")
        }
        if (Option.isSome(previous)) return previous.value.balance
        return Option.isSome(last) ? yield* balanceOf(address, last.value.signature, "pre") : BigInt(0)
      })

      const fetchNativeBalance = Effect.fn("SolanaIndexer.fetchNativeBalance")(
        function*({ address, block }: { readonly address: SolanaAddress; readonly block: bigint }) {
          return yield* balanceAt(address, block, yield* lastConfirmedBlock, Option.none())
        }
      )

      const streamNativeBalance = (
        { address, fromBlock, poll = Schedule.spaced(DEFAULT_POLL_INTERVAL), retry, step, toBlock }:
          SolanaIndexerNativeBalanceOptions
      ): Stream.Stream<SolanaNativeBalance, SolanaRpcError> => {
        if (!Number.isSafeInteger(step) || step < 1) {
          return Stream.die(new RangeError(`step must be a positive safe integer, got ${step}`))
        }
        if (toBlock !== undefined && fromBlock > toBlock) {
          return Stream.empty
        }
        const sample = (
          previous: Option.Option<SolanaNativeBalance>
        ): Effect.Effect<Sample, SolanaRpcError> => {
          const block = Option.match(previous, { onNone: () => fromBlock, onSome: (p) => p.block + BigInt(step) })
          return lastConfirmedBlock.pipe(
            Effect.repeat({ schedule: poll, until: (confirmed) => confirmed >= block }),
            Effect.flatMap((confirmed) =>
              confirmed < block
                ? Effect.succeed<Sample>([[], Option.none()])
                : balanceAt(address, block, confirmed, previous).pipe(Effect.map((balance): Sample => {
                  const current = { block, balance }
                  return [
                    [current],
                    toBlock !== undefined && block + BigInt(step) > toBlock
                      ? Option.none()
                      : Option.some(Option.some(current))
                  ]
                }))
            ),
            Effect.withSpan("SolanaIndexer.streamNativeBalance.sample")
          )
        }
        return Stream.paginate(Option.none<SolanaNativeBalance>(), withRetry(retry, sample))
      }

      return SolanaIndexer.of({
        lastConfirmedBlock,
        fetchTransactions,
        streamTransactions,
        fetchNativeBalance,
        streamNativeBalance
      })
    })
  )

/**
 * Builds an {@link SolanaIndexer} like {@link layer}, reading the options from `Config`.
 *
 * @example
 * ```ts
 * import * as SolanaIndexer from "@effect-blockchain/solana/SolanaIndexer"
 * import * as Config from "effect/Config"
 *
 * const IndexerLive = SolanaIndexer.layerConfig({ confirmations: Config.Int("SOLANA_CONFIRMATIONS") })
 * ```
 *
 * @since 0.1.0
 * @category layers
 */
export const layerConfig = (
  options: Config.Wrap<NonNullable<Parameters<typeof layer>[0]>>
): Layer.Layer<SolanaIndexer, Config.ConfigError, SolanaRpc> => Layer.unwrap(Effect.map(Config.unwrap(options), layer))
