/**
 * Starknet transaction relaying on top of {@link StarknetRpc.StarknetRpc}: signing a transaction, broadcasting it and
 * following it until it is final.
 *
 * A relayer here sends an account's own transactions and manages their nonces and fees, as OpenZeppelin Relayer does.
 * It is not a meta-transaction relayer (a paymaster, SNIP-9 outside execution) paying for someone else's transaction.
 * It keeps no state: storing hashes and nonces, deciding when to resend and holding keys belong to the application.
 * Senders sharing an account must each pass their own nonce, as the node's nonce does not count a transaction that is
 * signed and not yet in a pre-confirmed block, and two concurrent `sign` calls read the same one.
 *
 * Only V3 transactions are sent: an `INVOKE` running calls through the `__execute__` entrypoint of a Cairo 1 account
 * (SNIP-6), and the `DEPLOY_ACCOUNT` of the signer's own account. `sign` and `signDeployAccount` return the
 * transaction hash before anything is broadcast, so it can be stored first, and `broadcast` can be repeated with the
 * same transaction.
 *
 * Resource bounds come from `starknet_estimateFee` (see {@link defaultFees}) unless `sign` receives them. The
 * transaction is estimated unsigned, with `SKIP_VALIDATE`, so that a custody signer signs once: the estimate leaves
 * out the account's validation, which the default strategy adds back. The account must hold the bounds in STRK, each
 * `maxAmount` times its `maxPricePerUnit`, though it only pays what the transaction uses. The tip is 0 unless given.
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
 * import type { StarknetAddress } from "@effect-blockchain/starknet/StarknetAddress"
 * import { StarknetRelayer } from "@effect-blockchain/starknet/StarknetRelayer"
 * import type { StarknetSigner } from "@effect-blockchain/starknet/StarknetSigner"
 * import type { StarknetTransactionHash } from "@effect-blockchain/starknet/StarknetTransactionHash"
 * import * as Effect from "effect/Effect"
 *
 * declare const signer: StarknetSigner
 * declare const token: StarknetAddress
 * declare const to: StarknetAddress
 * declare const store: (hash: StarknetTransactionHash, nonce: bigint) => Effect.Effect<void>
 *
 * const program = Effect.gen(function*() {
 *   const relayer = yield* StarknetRelayer
 *   // an ERC-20 `transfer(recipient, amount)`, the amount being a u256 as two felts
 *   const calls = [{ contractAddress: token, entrypoint: "transfer", calldata: [to, "0x1", "0x0"] }]
 *   const { hash, nonce, signed } = yield* relayer.sign({ signer, calls })
 *   // stored before the broadcast: a crash in between leaves a hash to look up, never an unknown transaction
 *   yield* store(hash, nonce)
 *   yield* relayer.broadcast({ signed })
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
import * as Confirmations from "@effect-blockchain/core/Confirmations"
import * as JsonRpc from "@effect-blockchain/core/JsonRpc"
import * as Context from "effect/Context"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import { hash as starknetHash } from "starknet"
import { deployAddress, transactionHash } from "./internal/transactionHash.ts"
import type { StarknetAddress } from "./StarknetAddress.ts"
import * as StarknetNetwork from "./StarknetNetwork.ts"
import * as StarknetRpc from "./StarknetRpc.ts"
import { type StarknetSigner, StarknetSignerError, type StarknetUnsignedTransaction } from "./StarknetSigner.ts"
import type { StarknetResourceBounds, StarknetTransaction } from "./StarknetTransaction.ts"
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
 * One call of an `INVOKE` transaction: the `entrypoint` name of `contractAddress` and its calldata felts.
 *
 * @since 0.2.0
 * @category models
 */
export interface StarknetCall {
  readonly contractAddress: StarknetAddress
  readonly entrypoint: string
  readonly calldata: ReadonlyArray<string>
}

/**
 * A transaction signed by {@link StarknetRelayer}: `signed` is what `broadcast` takes, `hash` its transaction hash
 * and `nonce` the nonce it uses.
 *
 * @since 0.2.0
 * @category models
 */
export interface StarknetSignedTransaction {
  readonly hash: StarknetTransactionHash
  readonly signed: StarknetTransaction
  readonly nonce: bigint
}

/**
 * The nonce is not the account's next one: it is already used, or too far ahead of it (`INVALID_TRANSACTION_NONCE`).
 *
 * @since 0.2.0
 * @category reasons
 */
export class InvalidNonce extends Schema.TaggedError<InvalidNonce>()("InvalidNonce", {}) {}

/**
 * The account's STRK balance does not cover the resource bounds (`INSUFFICIENT_ACCOUNT_BALANCE`).
 *
 * @since 0.2.0
 * @category reasons
 */
export class InsufficientBalance extends Schema.TaggedError<InsufficientBalance>()("InsufficientBalance", {}) {}

/**
 * The resource bounds are below what validating the transaction needs or below the current prices
 * (`INSUFFICIENT_RESOURCES_FOR_VALIDATE`), or the fee is below the node's minimum (`FEE_BELOW_MINIMUM`).
 *
 * @since 0.2.0
 * @category reasons
 */
export class InsufficientResources extends Schema.TaggedError<InsufficientResources>()("InsufficientResources", {}) {}

/**
 * The account contract refused the transaction, usually for its signature (`VALIDATION_FAILURE`).
 *
 * @since 0.2.0
 * @category reasons
 */
export class ValidationFailure extends Schema.TaggedError<ValidationFailure>()("ValidationFailure", {}) {}

/**
 * The node's mempool holds another transaction at this nonce and the tip does not exceed its tip enough to replace it
 * (`REPLACEMENT_TRANSACTION_UNDERPRICED`).
 *
 * @since 0.2.0
 * @category reasons
 */
export class ReplacementUnderpriced
  extends Schema.TaggedError<ReplacementUnderpriced>()("ReplacementUnderpriced", {})
{}

/**
 * Why a node refused a transaction, the `reason` of a {@link StarknetBroadcastError}, matched with
 * `Effect.catchReason`.
 *
 * @since 0.2.0
 * @category reasons
 */
export const StarknetBroadcastReason = Schema.Union([
  InvalidNonce,
  InsufficientBalance,
  InsufficientResources,
  ValidationFailure,
  ReplacementUnderpriced
])

/**
 * @since 0.2.0
 * @category reasons
 */
export type StarknetBroadcastReason = typeof StarknetBroadcastReason.Type

/**
 * A node refused the transaction for a `reason` the sender can act on: `cause` is the
 * {@link StarknetRpc.StarknetRpcError} holding the node's error code and message. Any other refusal stays a
 * `StarknetRpcError`.
 *
 * @since 0.2.0
 * @category errors
 */
export class StarknetBroadcastError extends Schema.TaggedError<StarknetBroadcastError>()("StarknetBroadcastError", {
  reason: StarknetBroadcastReason,
  cause: Schema.Defect()
}) {}

/**
 * @since 0.2.0
 * @category services
 */
export class StarknetRelayer extends Context.Service<StarknetRelayer, {
  /**
   * Signs an `INVOKE` running `calls` in order from the account at `signer.address`, without sending it. A missing
   * `nonce` is the account's nonce at the pre-confirmed block, missing `resourceBounds` come from the layer's fee
   * strategy over `starknet_estimateFee` (calls that revert fail with `Rejected`), and a missing `tip` is 0.
   */
  readonly sign: (options: {
    readonly signer: StarknetSigner
    readonly calls: ReadonlyArray<StarknetCall>
    readonly nonce?: bigint | undefined
    readonly resourceBounds?: StarknetResourceBounds | undefined
    readonly tip?: bigint | undefined
  }) => Effect.Effect<StarknetSignedTransaction, StarknetRpc.StarknetRpcError | StarknetSignerError>
  /**
   * Signs the `DEPLOY_ACCOUNT` of the signer's own account contract, without sending it: its nonce is 0. The address
   * that `classHash`, `salt` and `constructorCalldata` deploy to must be `signer.address`, or it fails with a
   * `StarknetSignerError`, and must hold STRK for the fee before the broadcast.
   */
  readonly signDeployAccount: (options: {
    readonly signer: StarknetSigner
    readonly classHash: string
    readonly salt: string
    readonly constructorCalldata: ReadonlyArray<string>
    readonly resourceBounds?: StarknetResourceBounds | undefined
    readonly tip?: bigint | undefined
  }) => Effect.Effect<StarknetSignedTransaction, StarknetRpc.StarknetRpcError | StarknetSignerError>
  /**
   * Sends a signed transaction and returns its hash. Sending the same transaction again is safe: a node answering
   * `DUPLICATE_TX`, or that the nonce is invalid while it knows this hash, is a success.
   */
  readonly broadcast: (options: {
    readonly signed: StarknetTransaction
  }) => Effect.Effect<StarknetTransactionHash, StarknetBroadcastError | StarknetRpc.StarknetRpcError>
  /**
   * The status of the transaction as the answering endpoint sees it. An endpoint behind the head answers `Pending` or
   * `Included` for a transaction another one has in a confirmed block, and `NotFound` means that the last endpoint
   * tried does not know it.
   */
  readonly fetchTransactionStatus: (options: {
    readonly hash: StarknetTransactionHash
  }) => Effect.Effect<StarknetTransactionStatus, StarknetRpc.StarknetRpcError>
  /**
   * Reads {@link fetchTransactionStatus} on `poll` (`Schedule.spaced(DEFAULT_POLL_INTERVAL)` by default) until it is
   * `Confirmed` or `Failed`, and returns it. `NotFound` keeps polling, so bound the wait with a timeout. A read failing
   * with a transient reason (`JsonRpc.isTransient`) is read again on `poll`, any other error fails the wait. A `poll`
   * that ends first returns the last read.
   */
  readonly awaitConfirmation: (options: {
    readonly hash: StarknetTransactionHash
    readonly poll?: Schedule.Schedule<unknown> | undefined
  }) => Effect.Effect<StarknetTransactionStatus, StarknetRpc.StarknetRpcError>
}>()("@effect-blockchain/starknet/StarknetRelayer") {}

// `__validate__` and `__validate_deploy__` of an OpenZeppelin account, one Stark curve signature check, use 130,240 L2
// gas: the estimate is made with `SKIP_VALIDATE` and leaves them out
const VALIDATION_L2_GAS = BigInt(300_000)

const margin = (value: bigint) => value * BigInt(3) / BigInt(2)

/**
 * The library's fee strategy: each resource is bounded by 1.5 times its estimated amount at 1.5 times its estimated
 * price, which keeps the transaction includable while prices rise. The L2 gas amount first gains 300,000 for the
 * account's validation, which the estimate leaves out: over twice what a single signature check uses.
 *
 * @since 0.2.0
 * @category fees
 */
export const defaultFees = (estimate: StarknetRpc.StarknetFeeEstimate): StarknetResourceBounds => ({
  l1Gas: { maxAmount: margin(estimate.l1GasConsumed), maxPricePerUnit: margin(estimate.l1GasPrice) },
  l1DataGas: { maxAmount: margin(estimate.l1DataGasConsumed), maxPricePerUnit: margin(estimate.l1DataGasPrice) },
  l2Gas: {
    maxAmount: margin(estimate.l2GasConsumed + VALIDATION_L2_GAS),
    maxPricePerUnit: margin(estimate.l2GasPrice)
  }
})

/**
 * The default `poll` spacing of {@link StarknetRelayer.Service.awaitConfirmation}: 10 seconds.
 *
 * @since 0.3.0
 * @category constants
 */
export const DEFAULT_POLL_INTERVAL: Duration.Duration = Confirmations.DEFAULT_POLL_INTERVAL

const NO_BOUND = { maxAmount: BigInt(0), maxPricePerUnit: BigInt(0) }

const toHex = (value: number) => `0x${value.toString(16)}`

// the `__execute__` calldata of a Cairo 1 account, an `Array<Call>` (SNIP-6)
const executeCalldata = (calls: ReadonlyArray<StarknetCall>): ReadonlyArray<string> => [
  toHex(calls.length),
  ...calls.flatMap((call) => [
    call.contractAddress,
    starknetHash.getSelectorFromName(call.entrypoint),
    toHex(call.calldata.length),
    ...call.calldata
  ])
]

// error codes of `starknet_addInvokeTransaction` and `starknet_addDeployAccountTransaction` in the Starknet JSON-RPC
// spec v0.9 (starknet_write_api.json)
const DUPLICATE_TX = 59
const refusals: ReadonlyMap<number | undefined, () => StarknetBroadcastReason> = new Map<
  number,
  () => StarknetBroadcastReason
>([
  [52, () => new InvalidNonce()],
  [53, () => new InsufficientResources()],
  [54, () => new InsufficientBalance()],
  [55, () => new ValidationFailure()],
  [64, () => new ReplacementUnderpriced()],
  [65, () => new InsufficientResources()]
])

// after a fallback, each endpoint's code in order
const codesOf = (error: StarknetRpc.StarknetRpcError): ReadonlyArray<number | undefined> =>
  JsonRpc.errorsOf(error).map((each) => each instanceof StarknetRpc.StarknetRpcError ? each.code : undefined)

const toSignerError = (cause: unknown) => new StarknetSignerError({ cause })

/**
 * Builds a {@link StarknetRelayer} over the provided {@link StarknetRpc.StarknetRpc}. `confirmations` overrides the
 * network's default, as in `StarknetIndexer.layer`: both agree on the last confirmed block. `fees` (default
 * {@link defaultFees}) bounds the resources of the transactions signed without explicit bounds.
 *
 * @since 0.2.0
 * @category layers
 */
export const layer = (options: {
  readonly confirmations?: number | undefined
  readonly fees?: ((estimate: StarknetRpc.StarknetFeeEstimate) => StarknetResourceBounds) | undefined
} = {}): Layer.Layer<StarknetRelayer, never, StarknetRpc.StarknetRpc> =>
  Layer.effect(
    StarknetRelayer,
    Effect.gen(function*() {
      const rpc = yield* StarknetRpc.StarknetRpc
      const confirmations = options.confirmations ?? StarknetNetwork.defaultConfirmations(rpc.network)
      const chainId = StarknetNetwork.toChainId(rpc.network)
      const finish = Effect.fnUntraced(function*(
        signer: StarknetSigner,
        draft: StarknetUnsignedTransaction,
        given: StarknetResourceBounds | undefined
      ) {
        const resourceBounds = given ?? (yield* Effect.map(
          rpc.estimateFee({
            transactions: [{ ...draft, signature: [] }],
            skipValidate: true,
            blockTag: "pre_confirmed"
          }),
          ([estimate]) => (options.fees ?? defaultFees)(estimate)
        ))
        const unsigned = { ...draft, resourceBounds }
        const hash = yield* Effect.try({ try: () => transactionHash(unsigned), catch: toSignerError })
        const signature = yield* signer.signTransaction(unsigned)
        return { hash, signed: { ...unsigned, signature }, nonce: unsigned.nonce }
      })
      const unbounded = { resourceBounds: { l1Gas: NO_BOUND, l1DataGas: NO_BOUND, l2Gas: NO_BOUND } }
      const sign = Effect.fn("StarknetRelayer.sign")(
        function*({ calls, nonce, resourceBounds, signer, tip }: Parameters<StarknetRelayer["Service"]["sign"]>[0]) {
          return yield* finish(signer, {
            ...unbounded,
            type: "INVOKE",
            chainId,
            senderAddress: signer.address,
            calldata: executeCalldata(calls),
            nonce: nonce ?? (yield* rpc.getNonce({ address: signer.address, blockTag: "pre_confirmed" })),
            tip: tip ?? BigInt(0)
          }, resourceBounds)
        }
      )
      const signDeployAccount = Effect.fn("StarknetRelayer.signDeployAccount")(
        function*(
          { classHash, constructorCalldata, resourceBounds, salt, signer, tip }: Parameters<
            StarknetRelayer["Service"]["signDeployAccount"]
          >[0]
        ) {
          const draft = {
            ...unbounded,
            type: "DEPLOY_ACCOUNT" as const,
            chainId,
            classHash,
            contractAddressSalt: salt,
            constructorCalldata,
            nonce: BigInt(0),
            tip: tip ?? BigInt(0)
          }
          const address = yield* Effect.try({ try: () => deployAddress(draft), catch: toSignerError })
          if (address !== signer.address) {
            return yield* toSignerError(new Error(`the account deploys at ${address}, the signer is ${signer.address}`))
          }
          return yield* finish(signer, draft, resourceBounds)
        }
      )
      const broadcast = Effect.fn("StarknetRelayer.broadcast")(
        function*({ signed }: { readonly signed: StarknetTransaction }) {
          const sent = yield* Effect.result(
            signed.type === "INVOKE"
              ? rpc.addInvokeTransaction({ transaction: signed })
              : Effect.map(rpc.addDeployAccountTransaction({ transaction: signed }), (added) => added.transactionHash)
          )
          if (sent._tag === "Success") return sent.success
          const cause = sent.failure
          const codes = codesOf(cause)
          if (codes.includes(DUPLICATE_TX)) return transactionHash(signed)
          const reason = refusals.get(codes.find((code) => refusals.has(code)))?.()
          if (reason === undefined) return yield* cause
          if (reason._tag === "InvalidNonce") {
            // a node that has this transaction in a block answers that its nonce is used
            const hash = transactionHash(signed)
            if ((yield* rpc.getTransactionStatus({ transactionHash: hash })) !== null) return hash
          }
          return yield* new StarknetBroadcastError({ reason, cause })
        }
      )
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
          const confirmed = Confirmations.lastConfirmedBlock(yield* rpc.blockNumber, confirmations)
          if (block > confirmed) return { _tag: "Included", block } as const
          return status.executionStatus === "REVERTED"
            ? { _tag: "Failed", block, reason: status.failureReason } as const
            : { _tag: "Confirmed", block } as const
        }
      )
      return StarknetRelayer.of({
        sign,
        signDeployAccount,
        broadcast,
        fetchTransactionStatus,
        awaitConfirmation: ({ hash, poll }) =>
          Confirmations.awaitConfirmation({
            fetch: fetchTransactionStatus({ hash }),
            isFinal: ({ _tag }) => _tag === "Confirmed" || _tag === "Failed",
            poll
          }).pipe(Effect.withSpan("StarknetRelayer.awaitConfirmation"))
      })
    })
  )
