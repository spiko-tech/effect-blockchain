/**
 * Raw indexing of the transactions touching one Solana address, on top of {@link SolanaRpc}. Blocks are slots.
 *
 * Everything is read at `finalized` commitment. `fetchTransactions` pages `getSignaturesForAddress` from the head
 * backwards (newest first, 1000 per page, `before` = the last signature of the previous page) until a page is short or
 * reaches below `fromBlock`, keeps the signatures with `fromBlock <= slot <= toBlock`, then calls `getTransaction` for
 * each, one after another. The node API has no slot range: the cost grows with the address's history between the head
 * and `fromBlock`, not with the size of the range.
 *
 * Every page carries `minContextSlot: toBlock`, so an endpoint that honours it and has not reached `toBlock` answers
 * `Lagging` and the call falls back to the next endpoint. Some providers ignore it (Alchemy, see
 * {@link SolanaRpc.SolanaSignaturesQuery}): reading at `finalized` limits the risk of a lagging node silently missing
 * recent signatures without removing it.
 *
 * Any failure fails the whole call with the {@link SolanaRpc.SolanaRpcError} of the last endpoint tried, e.g. `Pruned`
 * when no endpoint returns a transaction it has just listed. Nothing is returned partially: the caller retries the
 * same range.
 *
 * **Streaming**
 *
 * `streamTransactions` follows the confirmed head from `fromBlock`. A step reads `lastConfirmedBlock` and pages the
 * signatures of `[next, lastConfirmedBlock]` as `fetchTransactions` does, in chain order, then cuts them into groups of
 * at most `maxBatchSize` signatures without splitting a slot: a slot with more signatures stays whole in one group.
 * Each following step calls `getTransaction` for one group and emits it as one {@link SolanaIndexerBatch}, so a long
 * catch-up saves progress batch by batch and holds only the signature list in memory. The batches tile the range: the
 * first starts at `next`, each ends at its last slot and the next starts right after, the last ends at the confirmed
 * head. A range without signatures is one empty batch, so the caller's cursor moves on a quiet address. Caught up, the
 * stream sleeps `pollInterval` and checks again; with a `toBlock` it ends after the batch reaching it. With `retry`, a
 * step (the signature paging or one group's transactions) failing with a transient reason (`Unavailable`,
 * `InvalidResponse`, `Lagging`) is retried at the same position; any other failure, or an exhausted schedule, fails the
 * stream. Delivery is at-least-once: save `batch.toBlock` after handling a batch and restart from the slot after it.
 * Run one stream per (network, filter) at a time: the indexer does not coordinate processes, so a service with several
 * replicas provides the exclusivity itself, for example with a Postgres advisory lock.
 *
 * ```ts
 * import * as Effect from "effect/Effect"
 * import * as Stream from "effect/Stream"
 * import { SolanaIndexer } from "@effect-blockchain/solana/SolanaIndexer"
 * import type { SolanaIndexerFilter } from "@effect-blockchain/solana/SolanaIndexer"
 *
 * declare const filter: Omit<SolanaIndexerFilter, "fromBlock" | "toBlock">
 * declare const cursor: bigint
 * declare const save: (slot: bigint) => Effect.Effect<void>
 *
 * const program = Effect.gen(function*() {
 *   const indexer = yield* SolanaIndexer
 *   yield* indexer.streamTransactions({ filter, fromBlock: cursor + BigInt(1) }).pipe(
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
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import type * as Schedule from "effect/Schedule"
import type * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import type { SolanaAddress } from "./SolanaAddress.ts"
import * as SolanaNetwork from "./SolanaNetwork.ts"
import type { SolanaRpcError, SolanaSignatureInfo, SolanaTransactionInfo } from "./SolanaRpc.ts"
import { SolanaRpc } from "./SolanaRpc.ts"
import type { SolanaTransactionHash } from "./SolanaTransactionHash.ts"

/**
 * A transaction touching the indexed address, kept raw: the `getTransaction` result with its `signature` and the
 * `err` listed by `getSignaturesForAddress` (raw JSON, `null` when it succeeded). Failed transactions are kept: they
 * still paid their fee.
 *
 * @since 0.1.0
 * @category models
 */
export interface SolanaIndexedTransaction extends SolanaTransactionInfo {
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
 * {@link SolanaIndexer.Service.streamTransactions}. `transactions` can be empty.
 *
 * @since 0.1.0
 * @category models
 */
export interface SolanaIndexerBatch {
  readonly fromBlock: bigint
  readonly toBlock: bigint
  readonly transactions: ReadonlyArray<SolanaIndexedTransaction>
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
   * `fromBlock > toBlock`.
   */
  readonly fetchTransactions: (
    filter: SolanaIndexerFilter
  ) => Effect.Effect<ReadonlyArray<SolanaIndexedTransaction>, SolanaRpcError>
  /**
   * The transactions touching `filter.address` from slot `fromBlock` on, one batch of at most `maxBatchSize`
   * transactions at a time (more when a single slot has more), following the head: see the module's "Streaming"
   * section.
   *
   * - `toBlock`: the stream ends after the batch reaching it. `fromBlock > toBlock` is an empty stream.
   * - `pollInterval`: the wait once caught up, defaults to {@link DEFAULT_POLL_INTERVAL}.
   * - `retry`: retries a step failing with `Unavailable`, `InvalidResponse` or `Lagging` at the same position. Off by
   *   default: the first failure fails the stream.
   */
  readonly streamTransactions: (options: {
    readonly filter: Omit<SolanaIndexerFilter, "fromBlock" | "toBlock">
    readonly fromBlock: bigint
    readonly toBlock?: bigint | undefined
    readonly pollInterval?: Duration.Input | undefined
    // the schedule's output is ignored
    readonly retry?: Schedule.Schedule<unknown, SolanaRpcError> | undefined
  }) => Stream.Stream<SolanaIndexerBatch, SolanaRpcError>
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
 * The default `pollInterval` of {@link SolanaIndexer.Service.streamTransactions}: the wait before reading the head
 * again once caught up.
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
interface Position {
  readonly next: bigint
  readonly cap: bigint
  readonly groups: ReadonlyArray<Arr.NonEmptyReadonlyArray<SolanaSignatureInfo>>
}
type Step = readonly [ReadonlyArray<SolanaIndexerBatch>, Option.Option<Position>]

/**
 * Builds a {@link SolanaIndexer} on the provided {@link SolanaRpc}.
 *
 * - `confirmations` defaults to {@link SolanaNetwork.defaultConfirmations} of the rpc's network.
 * - `maxBatchSize`, a positive integer, the signatures per `streamTransactions` batch, defaults to
 *   {@link DEFAULT_MAX_BATCH_SIZE}.
 *
 * There is no `maxBlockRange`: `getSignaturesForAddress` takes no slot range, only a page size, so a range cannot be
 * split into chunks.
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
      // the signatures of `[fromBlock, toBlock]` in chain order, paged from the head back to the first short page or
      // the first page reaching below `fromBlock`
      const fetchSignatures = (filter: SolanaIndexerFilter) =>
        Stream.paginate(
          Option.none<SolanaTransactionHash>(),
          (before) =>
            rpc.getSignaturesForAddress({
              address: filter.address,
              before: Option.getOrUndefined(before),
              limit: PAGE_SIZE,
              commitment: COMMITMENT,
              minContextSlot: filter.toBlock
            }).pipe(Effect.map((page) => {
              const last = page.at(-1)
              return [
                page,
                last === undefined || page.length < PAGE_SIZE || last.slot < filter.fromBlock
                  ? Option.none()
                  : Option.some(Option.some(last.signature))
              ] as const
            }))
        ).pipe(
          Stream.runCollect,
          // The node lists newest first, so reversed, slots ascend. Within a slot the node's order is not documented:
          // reversing it is a best guess at execution order, not a guarantee. `transactionIndex`, which some
          // providers add, is not in the rpc model.
          Effect.map((signatures) =>
            Arr.reverse(Arr.filter(signatures, ({ slot }) => slot >= filter.fromBlock && slot <= filter.toBlock))
          )
        )
      const fetchEach = (signatures: ReadonlyArray<SolanaSignatureInfo>) =>
        Effect.forEach(signatures, ({ err, signature }) =>
          rpc.getTransaction({ signature, commitment: COMMITMENT }).pipe(
            Effect.map((tx): SolanaIndexedTransaction => ({ signature, err, ...tx }))
          ))

      return SolanaIndexer.of({
        lastConfirmedBlock,
        fetchTransactions: Effect.fn("SolanaIndexer.fetchTransactions")(function*(filter) {
          if (filter.fromBlock > filter.toBlock) return []
          return yield* fetchEach(yield* fetchSignatures(filter))
        }),
        streamTransactions: ({ filter, fromBlock, pollInterval = DEFAULT_POLL_INTERVAL, retry, toBlock }) => {
          if (toBlock !== undefined && fromBlock > toBlock) return Stream.empty
          // ends after the batch reaching `toBlock`
          const after = (end: bigint, cap: bigint, groups: Position["groups"]): Option.Option<Position> =>
            end === toBlock ? Option.none() : Option.some({ next: end + BigInt(1), cap, groups })
          // one step: the transactions of the next pending group, or the signatures up to the confirmed head, or a
          // sleep once caught up
          const step = (position: Position): Effect.Effect<Step, SolanaRpcError> => {
            const { cap, groups, next } = position
            if (Arr.isReadonlyArrayNonEmpty(groups)) {
              const [group, ...rest] = groups
              const end = rest.length === 0 ? cap : Arr.lastNonEmpty(group).slot
              return fetchEach(group).pipe(
                Effect.map((
                  transactions
                ): Step => [[{ fromBlock: next, toBlock: end, transactions }], after(end, cap, rest)]),
                Effect.withSpan("SolanaIndexer.streamTransactions.fetchGroup")
              )
            }
            return lastConfirmedBlock.pipe(Effect.flatMap((confirmed) => {
              const end = toBlock === undefined ? confirmed : BigInt_.min(confirmed, toBlock)
              if (next > end) return Effect.as(Effect.sleep(pollInterval), [[], Option.some(position)] as const)
              return fetchSignatures({ address: filter.address, fromBlock: next, toBlock: end }).pipe(
                Effect.map((signatures): Step =>
                  Arr.isReadonlyArrayNonEmpty(signatures)
                    ? [[], Option.some({ next, cap: end, groups: groupBySlot(signatures, maxBatchSize) })]
                    : [[{ fromBlock: next, toBlock: end, transactions: [] }], after(end, end, [])]
                ),
                Effect.withSpan("SolanaIndexer.streamTransactions.fetchSignatures")
              )
            }))
          }
          return Stream.paginate(
            { next: fromBlock, cap: fromBlock, groups: [] } satisfies Position,
            retry === undefined
              ? step
              : (position) =>
                Effect.retry(step(position), { schedule: retry, while: (error) => JsonRpc.isTransient(error.reason) })
          )
        }
      })
    })
  )
