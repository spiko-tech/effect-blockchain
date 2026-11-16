/**
 * EVM transaction relaying on top of {@link EvmRpc.EvmRpc}: following a transaction you sent until it is final.
 *
 * A relayer here sends an account's own transactions and manages their nonces and fees, as OpenZeppelin Relayer does.
 * It is not a meta-transaction relayer (Gelato, ERC-2771) paying for someone else's transaction. It keeps no state:
 * storing hashes and nonces, deciding when to resend and holding keys belong to the application. Senders sharing an
 * address must each pass their own nonce, as the node's pending count does not see a transaction that is signed and
 * not yet broadcast.
 *
 * A transaction is in one {@link EvmTransactionStatus}:
 *
 * | status | meaning | final |
 * |---|---|---|
 * | `Pending` | known to the node, not in a block | no |
 * | `Included` | in `block`, above the last confirmed block: a reorganisation can still move or drop it | no |
 * | `Confirmed` | succeeded in `block`, at or below the last confirmed block | yes |
 * | `Failed` | reverted in `block`, at or below the last confirmed block | yes |
 * | `NotFound` | unknown to the node: dropped, not propagated yet, or never sent | no |
 *
 * @example
 * ```ts
 * import { EvmRelayer } from "@effect-blockchain/evm/EvmRelayer"
 * import type { EvmTransactionHash } from "@effect-blockchain/evm/EvmTransactionHash"
 * import * as Effect from "effect/Effect"
 *
 * declare const hash: EvmTransactionHash
 *
 * const program = Effect.gen(function*() {
 *   const relayer = yield* EvmRelayer
 *   // a transaction the node never sees stays `NotFound`: the timeout bounds the wait
 *   const status = yield* relayer.awaitConfirmation({ hash }).pipe(Effect.timeout("10 minutes"))
 *   if (status._tag === "Failed") {
 *     yield* Effect.logError(`reverted in block ${status.block}`)
 *   }
 * })
 * ```
 *
 * @since 0.3.0
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schedule from "effect/Schedule"
import type { EvmHexData } from "./EvmHexData.ts"
import { DEFAULT_POLL_INTERVAL } from "./EvmIndexer.ts"
import * as EvmRpc from "./EvmRpc.ts"
import type { EvmTransactionHash } from "./EvmTransactionHash.ts"
import * as Confirmations from "./internal/confirmations.ts"

/**
 * Where a transaction stands, by `_tag`: see the module's table. `block` is the block holding it, and `reason` the
 * revert data, `undefined` when it is not available: a receipt does not carry it.
 *
 * @since 0.3.0
 * @category models
 */
export type EvmTransactionStatus =
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Included"; readonly block: bigint }
  | { readonly _tag: "Confirmed"; readonly block: bigint }
  | { readonly _tag: "Failed"; readonly block: bigint; readonly reason: EvmHexData | undefined }
  | { readonly _tag: "NotFound" }

/**
 * @since 0.3.0
 * @category services
 */
export class EvmRelayer extends Context.Service<EvmRelayer, {
  /**
   * The status of the transaction as the answering endpoint sees it. An endpoint behind the head, or one that never
   * received the transaction, answers `Pending` or `NotFound` for a transaction another one has in a block.
   */
  readonly fetchTransactionStatus: (options: {
    readonly hash: EvmTransactionHash
  }) => Effect.Effect<EvmTransactionStatus, EvmRpc.EvmRpcError>
  /**
   * Reads {@link fetchTransactionStatus} on `poll` (`Schedule.spaced(EvmIndexer.DEFAULT_POLL_INTERVAL)` by default) until it is
   * `Confirmed` or `Failed`, and returns it. `NotFound` keeps polling, so bound the wait with a timeout. A `poll` that
   * ends first returns the last status read.
   */
  readonly awaitConfirmation: (options: {
    readonly hash: EvmTransactionHash
    readonly poll?: Schedule.Schedule<unknown> | undefined
  }) => Effect.Effect<EvmTransactionStatus, EvmRpc.EvmRpcError>
}>()("@effect-blockchain/evm/EvmRelayer") {}

/**
 * Builds an {@link EvmRelayer} over the provided {@link EvmRpc.EvmRpc}. `confirmations` overrides the network's
 * default, as in `EvmIndexer.layer`: both agree on the last confirmed block.
 *
 * @since 0.3.0
 * @category layers
 */
export const layer = (options: {
  readonly confirmations?: number | undefined
} = {}): Layer.Layer<EvmRelayer, never, EvmRpc.EvmRpc> =>
  Layer.effect(
    EvmRelayer,
    Effect.gen(function*() {
      const rpc = yield* EvmRpc.EvmRpc
      const fetchTransactionStatus = Effect.fn("EvmRelayer.fetchTransactionStatus")(
        function*({ hash }: { readonly hash: EvmTransactionHash }) {
          const receipt = yield* rpc.getTransactionReceipt({ hash })
          if (receipt === null) {
            const transaction = yield* rpc.getTransactionByHash({ hash })
            return transaction === null ? { _tag: "NotFound" } as const : { _tag: "Pending" } as const
          }
          // read after the receipt: a head older than the receipt's block could only delay `Confirmed`
          const confirmed = yield* Confirmations.lastConfirmedBlock(rpc, options.confirmations)
          const block = receipt.blockNumber
          if (block > confirmed) return { _tag: "Included", block } as const
          return receipt.status === 1
            ? { _tag: "Confirmed", block } as const
            : { _tag: "Failed", block, reason: undefined } as const
        }
      )
      return EvmRelayer.of({
        fetchTransactionStatus,
        awaitConfirmation: ({ hash, poll = Schedule.spaced(DEFAULT_POLL_INTERVAL) }) =>
          fetchTransactionStatus({ hash }).pipe(
            Effect.repeat({ schedule: poll, until: ({ _tag }) => _tag === "Confirmed" || _tag === "Failed" }),
            Effect.withSpan("EvmRelayer.awaitConfirmation")
          )
      })
    })
  )
