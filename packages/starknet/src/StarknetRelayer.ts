/**
 * Starknet transaction relaying on top of {@link StarknetRpc.StarknetRpc}: following a transaction until it is final.
 *
 * A relayer here sends an account's own transactions and manages their nonces and fees, as OpenZeppelin Relayer does.
 * It is not a meta-transaction relayer (a paymaster, SNIP-9 outside execution) paying for someone else's transaction.
 * It keeps no state: storing hashes and deciding when to resend belong to the application.
 *
 * A transaction is in one {@link StarknetTransactionStatus}:
 *
 * | status | meaning | final |
 * |---|---|---|
 * | `Pending` | known to the node, not in an accepted block: received, candidate or pre-confirmed | no |
 * | `Included` | in the accepted block `block`, above the last confirmed block | no |
 * | `Confirmed` | succeeded in `block`, at or below the last confirmed block | yes |
 * | `Failed` | reverted in `block`, at or below the last confirmed block | yes |
 * | `NotFound` | unknown to the node: dropped, not propagated yet, or never sent | no |
 *
 * The last confirmed block is the one of `StarknetIndexer`: with the default of 0 confirmations, a transaction is
 * final as soon as its block is accepted on L2, and `Included` only shows while the head read is behind that block.
 *
 * @example
 * ```ts
 * import { StarknetRelayer } from "@effect-blockchain/starknet/StarknetRelayer"
 * import type { StarknetTransactionHash } from "@effect-blockchain/starknet/StarknetTransactionHash"
 * import * as Effect from "effect/Effect"
 *
 * declare const hash: StarknetTransactionHash
 *
 * const program = Effect.gen(function*() {
 *   const relayer = yield* StarknetRelayer
 *   const now = yield* relayer.fetchTransactionStatus({ hash })
 *   yield* Effect.log(`currently ${now._tag}`)
 *   // a transaction the node never sees stays `NotFound`: the timeout bounds the wait
 *   const status = yield* relayer.awaitConfirmation({ hash }).pipe(Effect.timeout("10 minutes"))
 *   if (status._tag === "Failed") {
 *     yield* Effect.logError(`reverted in block ${status.block}: ${status.reason}`)
 *   }
 * })
 * ```
 *
 * @since 0.2.0
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schedule from "effect/Schedule"
import * as Confirmations from "./internal/confirmations.ts"
import { DEFAULT_POLL_INTERVAL } from "./StarknetIndexer.ts"
import * as StarknetRpc from "./StarknetRpc.ts"
import type { StarknetTransactionHash } from "./StarknetTransactionHash.ts"

/**
 * Where a transaction stands, by `_tag`: see the module's table. `block` is the number of the accepted block holding
 * it, and `reason` the node's revert message, `undefined` when the node gives none.
 *
 * @since 0.2.0
 * @category models
 */
export type StarknetTransactionStatus =
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Included"; readonly block: bigint }
  | { readonly _tag: "Confirmed"; readonly block: bigint }
  | { readonly _tag: "Failed"; readonly block: bigint; readonly reason: string | undefined }
  | { readonly _tag: "NotFound" }

/**
 * @since 0.2.0
 * @category services
 */
export class StarknetRelayer extends Context.Service<StarknetRelayer, {
  /**
   * The status of the transaction as the answering endpoint sees it. An endpoint behind the head answers `Pending` or
   * `Included` for a transaction another one has in a confirmed block, and `NotFound` means that the last endpoint
   * tried does not know it.
   */
  readonly fetchTransactionStatus: (options: {
    readonly hash: StarknetTransactionHash
  }) => Effect.Effect<StarknetTransactionStatus, StarknetRpc.StarknetRpcError>
  /**
   * Reads {@link fetchTransactionStatus} on `poll` (`Schedule.spaced(StarknetIndexer.DEFAULT_POLL_INTERVAL)` by
   * default) until it is `Confirmed` or `Failed`, and returns it. `NotFound` keeps polling, so bound the wait with a
   * timeout. A `poll` that ends first returns the last status read.
   */
  readonly awaitConfirmation: (options: {
    readonly hash: StarknetTransactionHash
    readonly poll?: Schedule.Schedule<unknown> | undefined
  }) => Effect.Effect<StarknetTransactionStatus, StarknetRpc.StarknetRpcError>
}>()("@effect-blockchain/starknet/StarknetRelayer") {}

/**
 * Builds a {@link StarknetRelayer} over the provided {@link StarknetRpc.StarknetRpc}. `confirmations` overrides the
 * network's default, as in `StarknetIndexer.layer`: both agree on the last confirmed block.
 *
 * @since 0.2.0
 * @category layers
 */
export const layer = (options: {
  readonly confirmations?: number | undefined
} = {}): Layer.Layer<StarknetRelayer, never, StarknetRpc.StarknetRpc> =>
  Layer.effect(
    StarknetRelayer,
    Effect.gen(function*() {
      const rpc = yield* StarknetRpc.StarknetRpc
      const fetchTransactionStatus = Effect.fn("StarknetRelayer.fetchTransactionStatus")(
        function*({ hash }: { readonly hash: StarknetTransactionHash }) {
          const status = yield* rpc.getTransactionStatus({ transactionHash: hash })
          if (status === null) return { _tag: "NotFound" } as const
          if (status.finalityStatus !== "ACCEPTED_ON_L2" && status.finalityStatus !== "ACCEPTED_ON_L1") {
            return { _tag: "Pending" } as const
          }
          // the status does not carry the block number
          const { blockNumber: block } = yield* rpc.getTransactionReceipt({ transactionHash: hash })
          // read after the receipt: a head older than the receipt's block could only delay `Confirmed`
          const confirmed = yield* Confirmations.lastConfirmedBlock(rpc, options.confirmations)
          if (block > confirmed) return { _tag: "Included", block } as const
          return status.executionStatus === "REVERTED"
            ? { _tag: "Failed", block, reason: status.failureReason } as const
            : { _tag: "Confirmed", block } as const
        }
      )
      return StarknetRelayer.of({
        fetchTransactionStatus,
        awaitConfirmation: ({ hash, poll = Schedule.spaced(DEFAULT_POLL_INTERVAL) }) =>
          fetchTransactionStatus({ hash }).pipe(
            Effect.repeat({ schedule: poll, until: ({ _tag }) => _tag === "Confirmed" || _tag === "Failed" }),
            Effect.withSpan("StarknetRelayer.awaitConfirmation")
          )
      })
    })
  )
