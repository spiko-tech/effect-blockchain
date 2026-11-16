/**
 * Solana transaction relaying on top of {@link SolanaRpc.SolanaRpc}: following a transaction you sent until it is
 * final.
 *
 * A relayer here sends an account's own transactions and manages their fees, as OpenZeppelin Relayer does. It is not
 * a meta-transaction relayer paying for someone else's transaction. It keeps no state: storing signatures and their
 * `lastValidBlockHeight`, deciding when to resend and holding keys belong to the application.
 *
 * A transaction is in one {@link SolanaTransactionStatus}:
 *
 * | status | meaning | final |
 * |---|---|---|
 * | `Pending` | never reported: a node does not expose the transactions it has not processed | no |
 * | `Included` | in `block`, not finalized or above the last confirmed slot: a fork can still drop it | no |
 * | `Confirmed` | succeeded in `block`, finalized, at or below the last confirmed slot | yes |
 * | `Failed` | failed in `block`, finalized, at or below the last confirmed slot: it paid its fee | yes |
 * | `Expired` | unknown to the node, and its blockhash expired: it can no longer land | yes |
 * | `NotFound` | unknown to the node: not processed yet, dropped, or never sent | no |
 *
 * A node reports a transaction as soon as it has processed its block, then the block reaches the `confirmed`
 * commitment (voted by a supermajority) and the `finalized` one. `processed` and `confirmed` are both `Included`:
 * the `Confirmed` status is not the `confirmed` commitment. A `finalized` transaction is `Confirmed` or `Failed` once
 * its slot is at or below the last confirmed slot, the finalized slot minus `confirmations` (0 by default), as
 * `SolanaIndexer.lastConfirmedBlock`.
 *
 * A transaction can land only while the block height is at most the `lastValidBlockHeight` returned with its recent
 * blockhash. `Expired` is reported when the caller passes that height and the `finalized` block height is above it,
 * so a transaction that can still land is never `Expired`. A durable-nonce transaction does not expire: leave
 * `lastValidBlockHeight` out.
 *
 * @example
 * ```ts
 * import { SolanaRelayer } from "@effect-blockchain/solana/SolanaRelayer"
 * import type { SolanaTransactionHash } from "@effect-blockchain/solana/SolanaTransactionHash"
 * import * as Effect from "effect/Effect"
 *
 * declare const hash: SolanaTransactionHash
 * // returned by `getLatestBlockhash` with the blockhash the transaction was signed with
 * declare const lastValidBlockHeight: bigint
 *
 * const program = Effect.gen(function*() {
 *   const relayer = yield* SolanaRelayer
 *   const now = yield* relayer.fetchTransactionStatus({ hash, lastValidBlockHeight })
 *   yield* Effect.log(`status: ${now._tag}`)
 *   // a lagging endpoint can answer `NotFound` for a while: the timeout bounds the wait
 *   const status = yield* relayer.awaitConfirmation({ hash, lastValidBlockHeight }).pipe(Effect.timeout("5 minutes"))
 *   if (status._tag === "Failed") {
 *     yield* Effect.logError(`failed in slot ${status.block}`, status.reason)
 *   }
 *   if (status._tag === "Expired") {
 *     yield* Effect.logError("never landed: sign it again with a new blockhash")
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
import { DEFAULT_POLL_INTERVAL } from "./SolanaIndexer.ts"
import * as SolanaRpc from "./SolanaRpc.ts"
import type { SolanaTransactionHash } from "./SolanaTransactionHash.ts"

/**
 * Where a transaction stands, by `_tag`: see the module's table. `block` is the slot holding it, and `reason` the
 * transaction error as the node returns it.
 *
 * @since 0.2.0
 * @category models
 */
export type SolanaTransactionStatus =
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Included"; readonly block: bigint }
  | { readonly _tag: "Confirmed"; readonly block: bigint }
  | { readonly _tag: "Failed"; readonly block: bigint; readonly reason: SolanaRpc.SolanaTransactionError }
  | { readonly _tag: "Expired" }
  | { readonly _tag: "NotFound" }

/**
 * The transaction to look up: its `hash` (its first signature) and the `lastValidBlockHeight` returned with its
 * recent blockhash. Without `lastValidBlockHeight`, an unknown transaction is `NotFound`, never `Expired`.
 *
 * @since 0.2.0
 * @category models
 */
export interface SolanaTransactionStatusOptions {
  readonly hash: SolanaTransactionHash
  readonly lastValidBlockHeight?: bigint | undefined
}

/**
 * @since 0.2.0
 * @category services
 */
export class SolanaRelayer extends Context.Service<SolanaRelayer, {
  /**
   * The status of the transaction as the answering endpoint sees it. An endpoint behind the head, or one that never
   * received the transaction, answers `NotFound`, or `Expired` when `lastValidBlockHeight` has passed, for a
   * transaction another one has in a block.
   */
  readonly fetchTransactionStatus: (
    options: SolanaTransactionStatusOptions
  ) => Effect.Effect<SolanaTransactionStatus, SolanaRpc.SolanaRpcError>
  /**
   * Reads {@link fetchTransactionStatus} on `poll` (`Schedule.spaced(SolanaIndexer.DEFAULT_POLL_INTERVAL)` by
   * default) until it is `Confirmed`, `Failed` or `Expired`, and returns it. `NotFound` keeps polling, so bound the
   * wait with a timeout. A `poll` that ends first returns the last status read.
   */
  readonly awaitConfirmation: (
    options: SolanaTransactionStatusOptions & { readonly poll?: Schedule.Schedule<unknown> | undefined }
  ) => Effect.Effect<SolanaTransactionStatus, SolanaRpc.SolanaRpcError>
}>()("@effect-blockchain/solana/SolanaRelayer") {}

/**
 * Builds a {@link SolanaRelayer} over the provided {@link SolanaRpc.SolanaRpc}. `confirmations` overrides the
 * network's default, as in `SolanaIndexer.layer`: both agree on the last confirmed slot.
 *
 * @since 0.2.0
 * @category layers
 */
export const layer = (options: {
  readonly confirmations?: number | undefined
} = {}): Layer.Layer<SolanaRelayer, never, SolanaRpc.SolanaRpc> =>
  Layer.effect(
    SolanaRelayer,
    Effect.gen(function*() {
      const rpc = yield* SolanaRpc.SolanaRpc
      const fetchTransactionStatus = Effect.fn("SolanaRelayer.fetchTransactionStatus")(
        function*({ hash, lastValidBlockHeight }: SolanaTransactionStatusOptions) {
          // read before the status: once the finalized height has passed `lastValidBlockHeight`, a block holding the
          // transaction is finalized too, and the status read that follows finds it
          const expired = lastValidBlockHeight !== undefined
            && (yield* rpc.getBlockHeight({ commitment: "finalized" })) > lastValidBlockHeight
          // the node's status cache only covers recent slots: without the history, an old transaction would be unknown
          const { value } = yield* rpc.getSignatureStatuses({ signatures: [hash], searchTransactionHistory: true })
          const status = value[0] ?? null
          if (status === null) return expired ? { _tag: "Expired" } as const : { _tag: "NotFound" } as const
          const block = status.slot
          if (status.confirmationStatus !== "finalized") return { _tag: "Included", block } as const
          // read after the status: a finalized slot older than the transaction's could only delay `Confirmed`
          if (block > (yield* Confirmations.lastConfirmedBlock(rpc, options.confirmations))) {
            return { _tag: "Included", block } as const
          }
          return status.err === null
            ? { _tag: "Confirmed", block } as const
            : { _tag: "Failed", block, reason: status.err } as const
        }
      )
      return SolanaRelayer.of({
        fetchTransactionStatus,
        awaitConfirmation: ({ poll = Schedule.spaced(DEFAULT_POLL_INTERVAL), ...transaction }) =>
          fetchTransactionStatus(transaction).pipe(
            Effect.repeat({
              schedule: poll,
              until: ({ _tag }) => _tag === "Confirmed" || _tag === "Failed" || _tag === "Expired"
            }),
            Effect.withSpan("SolanaRelayer.awaitConfirmation")
          )
      })
    })
  )
