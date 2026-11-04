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
 * @since 0.1.0
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type * as Schema from "effect/Schema"
import type { SolanaAddress } from "./SolanaAddress.ts"
import { defaultConfirmations } from "./SolanaNetwork.ts"
import { SolanaRpc, type SolanaRpcError, type SolanaSignatureInfo, type SolanaTransactionInfo } from "./SolanaRpc.ts"
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
  readonly fetchTransactions: (filter: {
    readonly address: SolanaAddress
    readonly fromBlock: bigint
    readonly toBlock: bigint
  }) => Effect.Effect<ReadonlyArray<SolanaIndexedTransaction>, SolanaRpcError>
}>()("@effect-blockchain/solana/SolanaIndexer") {}

// the node's maximum `limit`
const pageSize = 1000
const commitment = "finalized"

/**
 * Builds a {@link SolanaIndexer} on the provided {@link SolanaRpc}. `confirmations` defaults to
 * `defaultConfirmations` of the rpc's network.
 *
 * There is no `maxBlockRange`: `getSignaturesForAddress` takes no slot range, only a page size, so a range cannot be
 * split into chunks.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer = (options: {
  readonly confirmations?: number | undefined
}): Layer.Layer<SolanaIndexer, never, SolanaRpc> =>
  Layer.effect(
    SolanaIndexer,
    Effect.gen(function*() {
      const rpc = yield* SolanaRpc
      const confirmations = BigInt(options.confirmations ?? defaultConfirmations(rpc.network))

      const lastConfirmedBlock = rpc.getSlot({ commitment }).pipe(
        Effect.map((slot) => slot > confirmations ? slot - confirmations : BigInt(0))
      )

      const fetchTransactions = Effect.fn("SolanaIndexer.fetchTransactions")(
        function*({ address, fromBlock, toBlock }: {
          readonly address: SolanaAddress
          readonly fromBlock: bigint
          readonly toBlock: bigint
        }) {
          if (fromBlock > toBlock) return []
          const kept: Array<SolanaSignatureInfo> = []
          let before: SolanaTransactionHash | undefined
          while (true) {
            const page = yield* rpc.getSignaturesForAddress({
              address,
              before,
              limit: pageSize,
              commitment,
              minContextSlot: toBlock
            })
            kept.push(...page.filter(({ slot }) => slot >= fromBlock && slot <= toBlock))
            const last = page.at(-1)
            if (last === undefined || page.length < pageSize || last.slot < fromBlock) break
            before = last.signature
          }
          // The node lists newest first, so reversed, slots ascend. Within a slot the node's order is not documented:
          // reversing it is a best guess at execution order, not a guarantee. `transactionIndex`, which some providers
          // add, is not in the rpc model.
          kept.reverse()
          return yield* Effect.forEach(kept, ({ err, signature }) =>
            rpc.getTransaction({ signature, commitment }).pipe(
              Effect.map((tx): SolanaIndexedTransaction => ({ signature, err, ...tx }))
            ))
        }
      )

      return SolanaIndexer.of({ lastConfirmedBlock, fetchTransactions })
    })
  )
