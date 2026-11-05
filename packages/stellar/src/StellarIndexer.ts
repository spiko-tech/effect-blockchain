/**
 * Raw Soroban contract event indexer over {@link StellarRpc}: every event of a `getEvents` filter over any ledger
 * range, in chain order.
 *
 * Range logic, sequential:
 * - the range is cut into chunks of at most `maxBlockRange` ledgers,
 * - `contractIds` is cut into groups of at most 5, the RPC limit per filter (`MaxContractIDsLimit` in
 *   https://github.com/stellar/go-stellar-sdk/blob/main/protocols/rpc/get_events.go). Each group is fetched over the
 *   chunk and the chunk's events are merged in event id order, which is chain order,
 * - inside a chunk, `getEvents` is paged with its cursor until the cursor is `undefined`.
 *
 * Failures: the first page of a chunk goes through the RPC fallback, so its error is final. A later page is pinned to
 * the endpoint that issued the cursor and has no fallback: when it fails, the group's partial events in the chunk are
 * dropped and the group restarts once from its first page (on any endpoint). A second cursor page failure fails the call with
 * that error. Every error is a {@link StellarRpcError}, e.g. `Pruned` when no endpoint retains `fromBlock`.
 *
 * @since 0.1.0
 */
import * as Arr from "effect/Array"
import * as BigInt_ from "effect/BigInt"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Order from "effect/Order"
import * as Stream from "effect/Stream"
import type { StellarContractEvent } from "./StellarContractEvent.ts"
import * as StellarNetwork from "./StellarNetwork.ts"
import type { StellarEventsCursor, StellarEventsFilter, StellarRpcError } from "./StellarRpc.ts"
import { StellarRpc } from "./StellarRpc.ts"

/**
 * Default `maxBlockRange`: 10000 ledgers, the most a Stellar RPC scans per request (`LedgerScanLimit` in
 * https://github.com/stellar/stellar-rpc/blob/main/cmd/stellar-rpc/internal/methods/get_events.go), so a chunk with
 * fewer events than the page size is done in one request.
 *
 * @since 0.1.0
 * @category constants
 */
export const DEFAULT_MAX_BLOCK_RANGE = 10_000

/**
 * A {@link StellarEventsFilter} without its paging fields (`limit`, `cursor`), over the inclusive ledger range
 * `[fromBlock, toBlock]`. `contractIds` has no size limit here.
 *
 * @since 0.1.0
 * @category models
 */
export type StellarIndexerFilter = Omit<StellarEventsFilter, "limit" | "cursor">

/**
 * @since 0.1.0
 * @category services
 */
export class StellarIndexer extends Context.Service<StellarIndexer, {
  /** The latest ledger minus the configured confirmations, never below 0. */
  readonly lastConfirmedBlock: Effect.Effect<bigint, StellarRpcError>
  /**
   * Every contract event matching `filter`, in chain order (event id order). Events of failed contract calls
   * (`inSuccessfulContractCall: false`) are dropped. `fromBlock > toBlock` returns no events.
   */
  readonly fetchEvents: (
    filter: StellarIndexerFilter
  ) => Effect.Effect<ReadonlyArray<StellarContractEvent>, StellarRpcError>
}>()("@effect-blockchain/stellar/StellarIndexer") {}

const MAX_CONTRACT_IDS = 5

const byId = Order.mapInput(Order.String, (event: StellarContractEvent) => event.id)

/**
 * Builds a {@link StellarIndexer} over the provided {@link StellarRpc}.
 *
 * - `confirmations`: ledgers kept behind the latest one, default {@link StellarNetwork.defaultConfirmations} of the
 *   RPC's network.
 * - `maxBlockRange`: ledgers per chunk, a positive integer, default {@link DEFAULT_MAX_BLOCK_RANGE}.
 * - `limit`: `getEvents` page size, default the RPC's (1000), at most 10000.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer = (options: {
  readonly confirmations?: number | undefined
  readonly maxBlockRange?: number | undefined
  readonly limit?: number | undefined
} = {}): Layer.Layer<StellarIndexer, never, StellarRpc> =>
  Layer.effect(
    StellarIndexer,
    Effect.gen(function*() {
      const rpc = yield* StellarRpc
      const maxBlockRange = options.maxBlockRange ?? DEFAULT_MAX_BLOCK_RANGE
      if (!Number.isSafeInteger(maxBlockRange) || maxBlockRange < 1) {
        return yield* Effect.die(new RangeError(`maxBlockRange must be a positive integer, got ${maxBlockRange}`))
      }
      const confirmations = BigInt(options.confirmations ?? StellarNetwork.defaultConfirmations(rpc.network))
      const range = BigInt(maxBlockRange)
      const { limit } = options

      return StellarIndexer.of({
        lastConfirmedBlock: rpc.getLatestLedger.pipe(
          Effect.map((ledger) => BigInt_.max(ledger.sequence - confirmations, BigInt(0))),
          Effect.withSpan("StellarIndexer.lastConfirmedBlock")
        ),
        fetchEvents: Effect.fn("StellarIndexer.fetchEvents")((filter) => {
          if (filter.fromBlock > filter.toBlock) return Effect.succeed([])
          const groups = Arr.chunksOf(filter.contractIds, MAX_CONTRACT_IDS)
          const chunks = Arr.makeBy(
            Number((filter.toBlock - filter.fromBlock) / range) + 1,
            (i) => filter.fromBlock + BigInt(i) * range
          )
          return Effect.forEach(chunks, (fromBlock) => {
            const toBlock = BigInt_.min(fromBlock + range - BigInt(1), filter.toBlock)
            return Effect.forEach(groups, (contractIds) => {
              const group = { ...filter, contractIds, fromBlock, toBlock, limit }
              // pages until the cursor is undefined. The first page (no cursor) has the fallback chain, a cursor page
              // has not: a failed cursor page drops the group's events and restarts it once from its first page
              return Stream.paginate(
                Option.none<StellarEventsCursor>(),
                (cursor) =>
                  rpc.getEvents({ ...group, cursor: Option.getOrUndefined(cursor) }).pipe(Effect.mapBoth({
                    onFailure: (error) => Option.isNone(cursor) ? error : { cursorPage: error },
                    onSuccess: (page) =>
                      [page.events, Option.map(Option.fromUndefinedOr(page.cursor), Option.some)] as const
                  }))
              ).pipe(
                Stream.runCollect,
                Effect.retry({ times: 1, while: (error) => "cursorPage" in error }),
                Effect.mapError((error) => "cursorPage" in error ? error.cursorPage : error)
              )
            }).pipe(Effect.map((found) => groups.length > 1 ? Arr.sort(Arr.flatten(found), byId) : Arr.flatten(found)))
          }).pipe(Effect.map((chunks) => Arr.flatten(chunks).filter((event) => event.inSuccessfulContractCall)))
        })
      })
    })
  )
