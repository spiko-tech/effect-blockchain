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
 * the endpoint that issued the cursor and has no fallback: when it fails, the chunk's partial events are dropped and
 * the chunk restarts once from its first page (on any endpoint). A second cursor page failure fails the call with
 * that error. Every error is a {@link StellarRpcError}, e.g. `Pruned` when no endpoint retains `fromBlock`.
 *
 * @since 0.1.0
 */
import * as Arr from "effect/Array"
import * as BigInt_ from "effect/BigInt"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Order from "effect/Order"
import * as Result from "effect/Result"
import type { StellarContractEvent } from "./StellarContractEvent.ts"
import { defaultConfirmations } from "./StellarNetwork.ts"
import { StellarRpc } from "./StellarRpc.ts"
import type { StellarEventsFilter, StellarRpcError } from "./StellarRpc.ts"

/**
 * Default `maxBlockRange`: 10000 ledgers, the most a Stellar RPC scans per request (`LedgerScanLimit` in
 * https://github.com/stellar/stellar-rpc/blob/main/cmd/stellar-rpc/internal/methods/get_events.go), so a chunk with
 * fewer events than the page size is done in one request.
 *
 * @since 0.1.0
 * @category constants
 */
export const defaultMaxBlockRange = 10000

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

const maxContractIds = 5

const byId = Order.mapInput(Order.String, (event: StellarContractEvent) => event.id)

/**
 * Builds a {@link StellarIndexer} over the provided {@link StellarRpc}.
 *
 * - `confirmations`: ledgers kept behind the latest one, default `defaultConfirmations` of the RPC's network.
 * - `maxBlockRange`: ledgers per chunk, a positive integer, default {@link defaultMaxBlockRange}.
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
      const confirmations = BigInt(options.confirmations ?? defaultConfirmations(rpc.network))
      const maxBlockRange = options.maxBlockRange ?? defaultMaxBlockRange
      if (!Number.isInteger(maxBlockRange) || maxBlockRange < 1) {
        return yield* Effect.die(new RangeError(`maxBlockRange must be a positive integer, got ${maxBlockRange}`))
      }
      const range = BigInt(maxBlockRange)
      const { limit } = options

      return StellarIndexer.of({
        lastConfirmedBlock: Effect.map(
          rpc.getLatestLedger,
          (ledger) => BigInt_.max(ledger.sequence - confirmations, BigInt(0))
        ),
        fetchEvents: (filter) =>
          Effect.gen(function*() {
            const groups = Arr.chunksOf(filter.contractIds, maxContractIds)
            const events: Array<StellarContractEvent> = []
            for (let fromBlock = filter.fromBlock; fromBlock <= filter.toBlock; fromBlock += range) {
              const toBlock = BigInt_.min(fromBlock + range - BigInt(1), filter.toBlock)
              const chunk: Array<StellarContractEvent> = []
              for (const contractIds of groups) {
                const groupFilter = { ...filter, contractIds, fromBlock, toBlock, limit }
                // a failed cursor page drops the group's partial events and restarts it from its first page, once
                for (let attempt = 1;; attempt++) {
                  const first = yield* rpc.getEvents(groupFilter)
                  const found = [...first.events]
                  let cursor = first.cursor
                  let failure: StellarRpcError | undefined
                  while (cursor !== undefined) {
                    const page = yield* Effect.result(rpc.getEvents({ ...groupFilter, cursor }))
                    if (Result.isFailure(page)) {
                      failure = page.failure
                      break
                    }
                    found.push(...page.success.events)
                    cursor = page.success.cursor
                  }
                  if (failure === undefined) {
                    chunk.push(...found)
                    break
                  }
                  if (attempt === 2) return yield* Effect.fail(failure)
                }
              }
              events.push(...(groups.length > 1 ? Arr.sort(chunk, byId) : chunk))
            }
            return events.filter((event) => event.inSuccessfulContractCall)
          })
      })
    })
  )
