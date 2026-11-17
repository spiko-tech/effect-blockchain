/**
 * Signs EIP-1559 transactions, broadcasts them and follows them until they are final, on top of
 * {@link EvmRpc.EvmRpc}. The relayer keeps no state and `broadcast` is idempotent, as described in
 * [Concepts](https://github.com/spiko-tech/effect-blockchain/blob/main/docs/concepts.md#stateless-relayer).
 *
 * Fees come from `eth_feeHistory` and cover execution only: a rollup charges its L1 data fee on top. To replace a
 * pending transaction, call `sign` with the same nonce and with both fees at least 10% higher, the smallest bump
 * nodes accept.
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
 * import type { EvmAddress } from "@effect-blockchain/evm/EvmAddress"
 * import * as EvmRelayer from "@effect-blockchain/evm/EvmRelayer"
 * import * as EvmRpc from "@effect-blockchain/evm/EvmRpc"
 * import type { EvmSigner } from "@effect-blockchain/evm/EvmSigner"
 * import type { EvmTransactionHash } from "@effect-blockchain/evm/EvmTransactionHash"
 * import * as Config from "effect/Config"
 * import * as Effect from "effect/Effect"
 * import * as FetchHttpClient from "effect/http/FetchHttpClient"
 * import * as Layer from "effect/Layer"
 *
 * declare const signer: EvmSigner
 * declare const to: EvmAddress
 * declare const store: (hash: EvmTransactionHash, nonce: bigint) => Effect.Effect<void>
 *
 * const program = Effect.gen(function*() {
 *   const relayer = yield* EvmRelayer.EvmRelayer
 *   const { hash, nonce, signed } = yield* relayer.sign({ signer, to, value: BigInt(1) })
 *   yield* store(hash, nonce)
 *   yield* relayer.broadcast({ signed })
 *   // `NotFound` keeps polling: the timeout bounds the wait
 *   return yield* relayer.awaitConfirmation({ hash }).pipe(Effect.timeout("10 minutes"))
 * })
 *
 * const RpcLive = EvmRpc.layerConfig({
 *   network: Config.succeed("Ethereum"),
 *   endpoints: Config.all([Config.all({ name: Config.succeed("main"), url: Config.Redacted("ETHEREUM_RPC_URL") })])
 * })
 *
 * const main = program.pipe(
 *   Effect.provide(EvmRelayer.layer().pipe(Layer.provide(RpcLive), Layer.provide(FetchHttpClient.layer)))
 * )
 * ```
 *
 * @since 0.3.0
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
import * as Order from "effect/Order"
import type * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import { keccak256 } from "viem"
import type { EvmAddress } from "./EvmAddress.ts"
import type { EvmHexData } from "./EvmHexData.ts"
import * as EvmNetwork from "./EvmNetwork.ts"
import * as EvmRpc from "./EvmRpc.ts"
import type { EvmSigner, EvmSignerError } from "./EvmSigner.ts"
import { EvmTransactionHash } from "./EvmTransactionHash.ts"

/**
 * Where a transaction stands, by `_tag`: see the module's table. `block` is the block holding it. `reason` is always
 * `undefined`: a receipt does not carry the revert data.
 *
 * @since 0.3.0
 * @category models
 */
export type EvmTransactionStatus =
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Included"; readonly block: bigint }
  | { readonly _tag: "Confirmed"; readonly block: bigint }
  | { readonly _tag: "Failed"; readonly block: bigint; readonly reason: undefined }
  | { readonly _tag: "NotFound" }

/**
 * The transaction to look up: its `hash`.
 *
 * @since 0.4.0
 * @category models
 */
export interface EvmTransactionStatusOptions {
  readonly hash: EvmTransactionHash
}

/**
 * The fees of an EIP-1559 transaction, in wei per gas: the most it pays in total, and the part of it offered to the
 * block producer above the base fee.
 *
 * @since 0.3.0
 * @category models
 */
export interface EvmFees {
  readonly maxFeePerGas: bigint
  readonly maxPriorityFeePerGas: bigint
}

/**
 * What a fee strategy decides from, read with `eth_feeHistory` over the last 10 blocks: `baseFeePerGas` is the base
 * fee of the next block and `rewards` holds, per block from the oldest, the priority fee paid at the 25th, 50th and
 * 75th percentiles of its gas. A node may return fewer blocks or no `rewards`, and an empty block reports zeros.
 *
 * @since 0.3.0
 * @category models
 */
export interface EvmFeeEstimate {
  readonly baseFeePerGas: bigint
  readonly rewards: ReadonlyArray<ReadonlyArray<bigint>>
}

/**
 * A transaction signed by {@link EvmRelayer.sign}: `signed` is what `broadcast` takes, `hash` its transaction hash
 * and `nonce` the nonce it uses.
 *
 * @since 0.3.0
 * @category models
 */
export interface EvmSignedTransaction {
  readonly hash: EvmTransactionHash
  readonly signed: EvmHexData
  readonly nonce: bigint
}

/**
 * The simulation of the call failed: `error` is the node's message, with the revert reason when the node gives it.
 *
 * @since 0.4.0
 * @category reasons
 */
export class SimulationFailed extends Schema.TaggedError<SimulationFailed>()("SimulationFailed", {
  error: Schema.String
}) {}

/**
 * A transaction could not be prepared for signing, for a `reason` matched with `Effect.catchReason`: `cause` is the
 * {@link EvmRpc.EvmRpcError} of the refused `eth_estimateGas`.
 *
 * @since 0.4.0
 * @category errors
 */
export class EvmSimulationError extends Schema.TaggedError<EvmSimulationError>()("EvmSimulationError", {
  reason: Schema.Union([SimulationFailed]),
  cause: Schema.Defect()
}) {}

/**
 * The sender's nonce is already used by a transaction in a block, and the node does not know this one: another
 * transaction took its place.
 *
 * @since 0.4.0
 * @category reasons
 */
export class InvalidNonce extends Schema.TaggedError<InvalidNonce>()("InvalidNonce", {}) {}

/**
 * The node's pool holds another transaction at this nonce and the fees do not exceed its fees enough to replace it.
 *
 * @since 0.3.0
 * @category reasons
 */
export class ReplacementUnderpriced
  extends Schema.TaggedError<ReplacementUnderpriced>()("ReplacementUnderpriced", {})
{}

/**
 * The fees are below what the node accepts: `maxFeePerGas` under the base fee, or a priority fee under its minimum.
 *
 * @since 0.3.0
 * @category reasons
 */
export class FeeTooLow extends Schema.TaggedError<FeeTooLow>()("FeeTooLow", {}) {}

/**
 * The sender's balance does not cover `value` plus `gas` times `maxFeePerGas`.
 *
 * @since 0.3.0
 * @category reasons
 */
export class InsufficientFunds extends Schema.TaggedError<InsufficientFunds>()("InsufficientFunds", {}) {}

/**
 * Why a node refused a transaction, the `reason` of an {@link EvmBroadcastError}, matched with `Effect.catchReason`.
 *
 * @since 0.3.0
 * @category reasons
 */
export const EvmBroadcastReason = Schema.Union([InvalidNonce, ReplacementUnderpriced, FeeTooLow, InsufficientFunds])

/**
 * @since 0.3.0
 * @category reasons
 */
export type EvmBroadcastReason = typeof EvmBroadcastReason.Type

/**
 * A node refused the transaction for a `reason` the sender can act on: `cause` is the {@link EvmRpc.EvmRpcError}
 * holding the node's message. Any other refusal stays an `EvmRpcError`.
 *
 * @since 0.3.0
 * @category errors
 */
export class EvmBroadcastError extends Schema.TaggedError<EvmBroadcastError>()("EvmBroadcastError", {
  reason: EvmBroadcastReason,
  cause: Schema.Defect()
}) {}

/**
 * @since 0.3.0
 * @category services
 */
export class EvmRelayer extends Context.Service<EvmRelayer, {
  /**
   * Signs an EIP-1559 call of `to` from `signer.address` without sending it. A missing `nonce` is the sender's pending
   * transaction count, a missing `gas` is `eth_estimateGas` times the layer's `gasMultiplier` (a call the node
   * refuses to estimate, as one that reverts, fails with an {@link EvmSimulationError}), and missing `fees` come from
   * the layer's fee strategy.
   */
  readonly sign: (options: {
    readonly signer: EvmSigner
    readonly to: EvmAddress
    readonly data?: EvmHexData | undefined
    readonly value?: bigint | undefined
    readonly nonce?: bigint | undefined
    readonly gas?: bigint | undefined
    readonly fees?: EvmFees | undefined
  }) => Effect.Effect<EvmSignedTransaction, EvmRpc.EvmRpcError | EvmSignerError | EvmSimulationError>
  /**
   * Sends a signed transaction with `eth_sendRawTransaction` and returns its hash. Sending the same bytes again is
   * safe: a node answering that it already has the transaction, or that the nonce is used while it knows this hash,
   * is a success.
   */
  readonly broadcast: (options: {
    readonly signed: EvmHexData
  }) => Effect.Effect<EvmTransactionHash, EvmBroadcastError | EvmRpc.EvmRpcError>
  /**
   * The status of the transaction as the answering endpoint sees it. An endpoint behind the head, or one that never
   * received the transaction, answers `Pending` or `NotFound` for a transaction another one has in a block.
   */
  readonly fetchTransactionStatus: (
    options: EvmTransactionStatusOptions
  ) => Effect.Effect<EvmTransactionStatus, EvmRpc.EvmRpcError>
  /**
   * Reads {@link fetchTransactionStatus} on `poll` until it is `Confirmed` or `Failed`, and returns it. `NotFound`
   * keeps polling, so bound the wait with a timeout. `poll` and errors work as in
   * {@link Confirmations.awaitConfirmation}.
   */
  readonly awaitConfirmation: (
    options: EvmTransactionStatusOptions & { readonly poll?: Schedule.Schedule<unknown> | undefined }
  ) => Effect.Effect<EvmTransactionStatus, EvmRpc.EvmRpcError>
}>()("@effect-blockchain/evm/EvmRelayer") {}

/**
 * The default `poll` spacing of {@link EvmRelayer.Service.awaitConfirmation}: 10 seconds.
 *
 * @since 0.4.0
 * @category constants
 */
export const DEFAULT_POLL_INTERVAL: Duration.Duration = Confirmations.DEFAULT_POLL_INTERVAL

// geth's default `miner.gasprice` (0.001 gwei): the lowest tip its block producers take
const PRIORITY_FEE_FLOOR = BigInt(1_000_000)

const FEE_HISTORY = { blockCount: 10, newestBlock: "latest", rewardPercentiles: [25, 50, 75] } as const

/**
 * The library's fee strategy: the priority fee is the median over the blocks of their 50th percentile reward, at
 * least 0.001 gwei, and `maxFeePerGas` is twice the next base fee plus that priority fee. Doubling the base fee keeps
 * the transaction includable through 5 full blocks in a row, each raising the base fee by 12.5%.
 *
 * @since 0.3.0
 * @category fees
 */
export const defaultFees = (estimate: EvmFeeEstimate): EvmFees => {
  const medians = Arr.sort(
    Arr.filter(estimate.rewards.map((rewards) => rewards[1]), (reward) => reward !== undefined),
    Order.BigInt
  )
  const maxPriorityFeePerGas = BigInt_.max(
    medians[Math.floor(medians.length / 2)] ?? PRIORITY_FEE_FLOOR,
    PRIORITY_FEE_FLOOR
  )
  return { maxFeePerGas: estimate.baseFeePerGas * BigInt(2) + maxPriorityFeePerGas, maxPriorityFeePerGas }
}

// the refusals of geth (`core/txpool/errors.go`, `core/error.go`), also used by erigon, reth and anvil, then those
// of Nethermind (`AcceptTxResult`), Besu and anvil that differ
const alreadyKnown = /already known|AlreadyKnown|known transaction|already imported/i
const refusals: ReadonlyArray<readonly [RegExp, () => EvmBroadcastReason]> = [
  [/nonce too low|OldNonce/i, () => new InvalidNonce()],
  [/replacement transaction underpriced|ReplacementNotAllowed/i, () => new ReplacementUnderpriced()],
  [/insufficient funds|InsufficientFunds|exceeds transaction sender account balance/i, () => new InsufficientFunds()],
  [/underpriced|less than block base fee|FeeTooLow|gas price below configured minimum/i, () => new FeeTooLow()]
]

const messagesOf = (error: unknown) => JsonRpc.errorsOf(error).map(({ message }) => message).join("\n")

/**
 * Builds an {@link EvmRelayer} over the provided {@link EvmRpc.EvmRpc}. `confirmations` overrides the network's
 * default, as in `EvmIndexer.layer`: both agree on the last confirmed block. `fees` (default {@link defaultFees})
 * prices the transactions signed without explicit fees, and `gasMultiplier` (default 1.2) is the margin applied to
 * an estimated gas limit.
 *
 * @since 0.3.0
 * @category layers
 */
export const layer = (options: {
  readonly confirmations?: number | undefined
  readonly fees?: ((estimate: EvmFeeEstimate) => EvmFees) | undefined
  readonly gasMultiplier?: number | undefined
} = {}): Layer.Layer<EvmRelayer, never, EvmRpc.EvmRpc> =>
  Layer.effect(
    EvmRelayer,
    Effect.gen(function*() {
      const rpc = yield* EvmRpc.EvmRpc
      const chainId = EvmNetwork.toChainId(rpc.network)
      const confirmations = options.confirmations ?? EvmNetwork.defaultConfirmations(rpc.network)
      const gasPercent = BigInt(Math.round((options.gasMultiplier ?? 1.2) * 100))
      const estimateFees = Effect.map(rpc.feeHistory(FEE_HISTORY), (history) =>
        (options.fees ?? defaultFees)({
          baseFeePerGas: Arr.lastNonEmpty(history.baseFeePerGas),
          rewards: history.reward ?? []
        }))
      const sign = Effect.fn("EvmRelayer.sign")(
        function*({ signer, to, data, value, ...given }: Parameters<EvmRelayer["Service"]["sign"]>[0]) {
          const { fees, gas, nonce } = yield* Effect.all({
            nonce: given.nonce === undefined
              ? rpc.getTransactionCount({ address: signer.address, blockTag: "pending" })
              : Effect.succeed(given.nonce),
            gas: given.gas === undefined
              ? rpc.estimateGas({ from: signer.address, to, value, data }).pipe(
                Effect.map((estimate) => estimate * gasPercent / BigInt(100)),
                Effect.catchIf(
                  (cause) => cause.reason._tag === "Rejected",
                  (cause) =>
                    Effect.fail(
                      new EvmSimulationError({
                        reason: new SimulationFailed({ error: messagesOf(cause.cause) }),
                        cause
                      })
                    )
                )
              )
              : Effect.succeed(given.gas),
            fees: given.fees === undefined ? estimateFees : Effect.succeed(given.fees)
          }, { concurrency: "unbounded" })
          const signed = yield* signer.signTransaction({ chainId, nonce, to, value, data, gas, ...fees })
          return { hash: EvmTransactionHash.make(keccak256(signed)), signed, nonce }
        }
      )
      const broadcast = Effect.fn("EvmRelayer.broadcast")(
        function*({ signed }: { readonly signed: EvmHexData }) {
          const sent = yield* Effect.result(rpc.sendRawTransaction({ signed }))
          if (sent._tag === "Success") return sent.success
          const cause = sent.failure
          const hash = EvmTransactionHash.make(keccak256(signed))
          const messages = messagesOf(cause)
          if (alreadyKnown.test(messages)) return hash
          const reason = refusals.find(([pattern]) => pattern.test(messages))?.[1]()
          if (reason === undefined) return yield* cause
          // a node that has this transaction in a block answers that its nonce is used
          if (reason._tag === "InvalidNonce" && (yield* rpc.getTransactionByHash({ hash })) !== null) return hash
          return yield* new EvmBroadcastError({ reason, cause })
        }
      )
      const fetchTransactionStatus = Effect.fn("EvmRelayer.fetchTransactionStatus")(
        function*({ hash }: EvmTransactionStatusOptions) {
          const receipt = yield* rpc.getTransactionReceipt({ hash })
          if (receipt === null) {
            const transaction = yield* rpc.getTransactionByHash({ hash })
            return transaction === null ? { _tag: "NotFound" } as const : { _tag: "Pending" } as const
          }
          // read after the receipt: a head older than the receipt's block could only delay `Confirmed`
          const confirmed = Confirmations.lastConfirmedBlock(yield* rpc.blockNumber, confirmations)
          const block = receipt.blockNumber
          if (block > confirmed) return { _tag: "Included", block } as const
          return receipt.status === 1
            ? { _tag: "Confirmed", block } as const
            : { _tag: "Failed", block, reason: undefined } as const
        }
      )
      return EvmRelayer.of({
        sign,
        broadcast,
        fetchTransactionStatus,
        awaitConfirmation: ({ hash, poll }) =>
          Confirmations.awaitConfirmation({
            fetch: fetchTransactionStatus({ hash }),
            isFinal: ({ _tag }) => _tag === "Confirmed" || _tag === "Failed",
            poll
          }).pipe(Effect.withSpan("EvmRelayer.awaitConfirmation"))
      })
    })
  )

/**
 * Builds an {@link EvmRelayer} like {@link layer}, reading `confirmations` and `gasMultiplier` from `Config`. The fee
 * strategy is {@link defaultFees}.
 *
 * @example
 * ```ts
 * import * as EvmRelayer from "@effect-blockchain/evm/EvmRelayer"
 * import * as Config from "effect/Config"
 *
 * const RelayerLive = EvmRelayer.layerConfig({ confirmations: Config.Int("ETHEREUM_CONFIRMATIONS") })
 * ```
 *
 * @since 0.4.0
 * @category layers
 */
export const layerConfig = (
  options: Config.Wrap<Omit<NonNullable<Parameters<typeof layer>[0]>, "fees">>
): Layer.Layer<EvmRelayer, Config.ConfigError, EvmRpc.EvmRpc> => Layer.unwrap(Effect.map(Config.unwrap(options), layer))
