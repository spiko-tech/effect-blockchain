/**
 * Signs V3 `INVOKE` and `DEPLOY_ACCOUNT` transactions of a Cairo 1 account (SNIP-6), broadcasts them and follows them
 * until they are final, on top of {@link StarknetRpc.StarknetRpc}. The relayer keeps no state and `broadcast` is
 * idempotent, as described in
 * [Concepts](https://github.com/spiko-tech/effect-blockchain/blob/main/docs/concepts.md#stateless-relayer).
 *
 * Fees come from `starknet_estimateFee`, run unsigned with `SKIP_VALIDATE` so that a custody signer signs once. That
 * estimate leaves out the gas of the account's validation, which {@link defaultFees} adds back. The account must hold
 * each `maxAmount` times its `maxPricePerUnit` in STRK, and pays what the transaction uses.
 *
 * | status | meaning | final |
 * |---|---|---|
 * | `Pending` | known to the node, not in an accepted block: received, candidate or pre-confirmed | no |
 * | `Included` | in the accepted block `block`, above the last confirmed block | no |
 * | `Confirmed` | succeeded in `block`, at or below the last confirmed block | yes |
 * | `Failed` | reverted in `block`, at or below the last confirmed block | yes |
 * | `NotFound` | unknown to the node: dropped, not propagated yet, or never sent | no |
 *
 * With the default of 0 confirmations, a transaction is final once its block is accepted on L2, and `Included` only
 * shows while the head read is behind that block.
 *
 * @example
 * ```ts
 * import type { StarknetAddress } from "@effect-blockchain/starknet/StarknetAddress"
 * import * as StarknetRelayer from "@effect-blockchain/starknet/StarknetRelayer"
 * import * as StarknetRpc from "@effect-blockchain/starknet/StarknetRpc"
 * import type { StarknetSigner } from "@effect-blockchain/starknet/StarknetSigner"
 * import type { StarknetTransactionHash } from "@effect-blockchain/starknet/StarknetTransactionHash"
 * import * as Config from "effect/Config"
 * import * as Effect from "effect/Effect"
 * import * as FetchHttpClient from "effect/http/FetchHttpClient"
 * import * as Layer from "effect/Layer"
 *
 * declare const signer: StarknetSigner
 * declare const token: StarknetAddress
 * declare const to: StarknetAddress
 * declare const store: (hash: StarknetTransactionHash, nonce: bigint) => Effect.Effect<void>
 *
 * const program = Effect.gen(function*() {
 *   const relayer = yield* StarknetRelayer.StarknetRelayer
 *   // an ERC-20 `transfer(recipient, amount)`, the amount being a u256 as two felts
 *   const calls = [{ contractAddress: token, entrypoint: "transfer", calldata: [to, "0x1", "0x0"] }] as const
 *   const { hash, nonce, signed } = yield* relayer.sign({ signer, calls })
 *   yield* store(hash, nonce)
 *   yield* relayer.broadcast({ signed })
 *   // `NotFound` keeps polling: the timeout bounds the wait
 *   return yield* relayer.awaitConfirmation({ hash }).pipe(Effect.timeout("10 minutes"))
 * })
 *
 * const RpcLive = StarknetRpc.layerConfig({
 *   network: Config.succeed("Starknet"),
 *   endpoints: Config.all([Config.all({ name: Config.succeed("main"), url: Config.Redacted("STARKNET_RPC_URL") })])
 * })
 *
 * const main = program.pipe(
 *   Effect.provide(StarknetRelayer.layer().pipe(Layer.provide(RpcLive), Layer.provide(FetchHttpClient.layer)))
 * )
 * ```
 *
 * @since 0.2.0
 */
import * as Confirmations from "@effect-blockchain/core/Confirmations"
import * as JsonRpc from "@effect-blockchain/core/JsonRpc"
import type * as Arr from "effect/Array"
import * as Config from "effect/Config"
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
 * The transaction that `fetchTransactionStatus` and `awaitConfirmation` read, by its `hash`.
 *
 * @since 0.3.0
 * @category models
 */
export interface StarknetTransactionStatusOptions {
  readonly hash: StarknetTransactionHash
}

/**
 * What a transaction may pay: the most of each resource it may use and the price it accepts for it, and the `tip`
 * per unit of L2 gas, in FRI (10^-18 STRK).
 *
 * @since 0.3.0
 * @category models
 */
export interface StarknetFees {
  readonly resourceBounds: StarknetResourceBounds
  readonly tip: bigint
}

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
 * @since 0.3.0
 * @category reasons
 */
export class InsufficientFunds extends Schema.TaggedError<InsufficientFunds>()("InsufficientFunds", {}) {}

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
  InsufficientFunds,
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
 * The estimate ran the transaction and it failed (`TRANSACTION_EXECUTION_ERROR`): `error` is the node's message.
 *
 * @since 0.3.0
 * @category reasons
 */
export class SimulationFailed extends Schema.TaggedError<SimulationFailed>()("SimulationFailed", {
  error: Schema.String
}) {}

/**
 * `starknet_estimateFee` refused the transaction, for a `reason` matched with `Effect.catchReason`: `cause` is the
 * {@link StarknetRpc.StarknetRpcError} of the estimate. A failed request stays a `StarknetRpcError`.
 *
 * @since 0.3.0
 * @category errors
 */
export class StarknetSimulationError extends Schema.TaggedError<StarknetSimulationError>()("StarknetSimulationError", {
  reason: Schema.Union([SimulationFailed]),
  cause: Schema.Defect()
}) {}

/**
 * @since 0.2.0
 * @category services
 */
export class StarknetRelayer extends Context.Service<StarknetRelayer, {
  /**
   * Signs an `INVOKE` running `calls` in order from the account at `signer.address`, without sending it. A missing
   * `nonce` is the account's nonce at the pre-confirmed block, and missing `fees` come from the layer's fee strategy
   * over `starknet_estimateFee`: calls that revert fail with a {@link StarknetSimulationError}.
   */
  readonly sign: (options: {
    readonly signer: StarknetSigner
    readonly calls: Arr.NonEmptyReadonlyArray<StarknetCall>
    readonly nonce?: bigint | undefined
    readonly fees?: StarknetFees | undefined
  }) => Effect.Effect<
    StarknetSignedTransaction,
    StarknetRpc.StarknetRpcError | StarknetSignerError | StarknetSimulationError
  >
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
    readonly fees?: StarknetFees | undefined
  }) => Effect.Effect<
    StarknetSignedTransaction,
    StarknetRpc.StarknetRpcError | StarknetSignerError | StarknetSimulationError
  >
  /**
   * The fees `sign` would use for the same `calls` from the account at `signer.address` or `address`, with the
   * node's `overallFee` for that estimate in FRI, which leaves out the account's validation. A missing `nonce` is read
   * as in `sign`, and calls that revert fail with a {@link StarknetSimulationError}.
   *
   * @since 0.5.0
   */
  readonly estimateFees: (
    options: ({ readonly signer: StarknetSigner } | { readonly address: StarknetAddress }) & {
      readonly calls: Arr.NonEmptyReadonlyArray<StarknetCall>
      readonly nonce?: bigint | undefined
    }
  ) => Effect.Effect<
    StarknetFees & { readonly overallFee: bigint },
    StarknetRpc.StarknetRpcError | StarknetSimulationError
  >
  /**
   * The fees `signDeployAccount` would use for the same deployment, with the node's `overallFee` as in
   * `estimateFees`. It checks the deployed address against `signer.address` as `signDeployAccount` does.
   *
   * @since 0.5.0
   */
  readonly estimateDeployAccountFees: (options: {
    readonly signer: StarknetSigner
    readonly classHash: string
    readonly salt: string
    readonly constructorCalldata: ReadonlyArray<string>
  }) => Effect.Effect<
    StarknetFees & { readonly overallFee: bigint },
    StarknetRpc.StarknetRpcError | StarknetSignerError | StarknetSimulationError
  >
  /**
   * Sends a signed transaction and returns its hash. Sending the same transaction again is safe: a node answering
   * `DUPLICATE_TX`, or that the nonce is invalid while it knows this hash, is a success.
   */
  readonly broadcast: (options: {
    readonly signed: StarknetTransaction
  }) => Effect.Effect<StarknetTransactionHash, StarknetBroadcastError | StarknetRpc.StarknetRpcError>
  /**
   * The status of the transaction as the answering endpoint sees it. An endpoint behind the head answers `Pending` or
   * `Included` for a transaction another one has in a confirmed block, and `NotFound` means that no endpoint knows
   * it.
   */
  readonly fetchTransactionStatus: (
    options: StarknetTransactionStatusOptions
  ) => Effect.Effect<StarknetTransactionStatus, StarknetRpc.StarknetRpcError>
  /**
   * Reads {@link fetchTransactionStatus} on `poll` until it is `Confirmed` or `Failed`, and returns it. `NotFound`
   * keeps polling, so bound the wait with a timeout. `poll` and errors work as in
   * {@link Confirmations.awaitConfirmation}.
   */
  readonly awaitConfirmation: (
    options: StarknetTransactionStatusOptions & { readonly poll?: Schedule.Schedule<unknown> | undefined }
  ) => Effect.Effect<StarknetTransactionStatus, StarknetRpc.StarknetRpcError>
}>()("@effect-blockchain/starknet/StarknetRelayer") {}

// `__validate__` and `__validate_deploy__` of an OpenZeppelin account, one Stark curve signature check, use 130,240 L2
// gas: the estimate is made with `SKIP_VALIDATE` and leaves them out
const VALIDATION_L2_GAS = BigInt(300_000)

const feesWith = (multiplier: number) => {
  const percent = BigInt(Math.round(multiplier * 100))
  const margin = (value: bigint) => value * percent / BigInt(100)
  return (estimate: StarknetRpc.StarknetFeeEstimate): StarknetFees => ({
    resourceBounds: {
      l1Gas: { maxAmount: margin(estimate.l1GasConsumed), maxPricePerUnit: margin(estimate.l1GasPrice) },
      l1DataGas: { maxAmount: margin(estimate.l1DataGasConsumed), maxPricePerUnit: margin(estimate.l1DataGasPrice) },
      l2Gas: {
        maxAmount: margin(estimate.l2GasConsumed + VALIDATION_L2_GAS),
        maxPricePerUnit: margin(estimate.l2GasPrice)
      }
    },
    tip: BigInt(0)
  })
}

/**
 * The library's fee strategy: each resource is bounded by 1.5 times its estimated amount at 1.5 times its estimated
 * price, which keeps the transaction includable while prices rise, with no tip. The L2 gas amount first gains 300,000
 * for the account's validation, which the estimate leaves out: over twice what a single signature check uses.
 *
 * @since 0.3.0
 * @category fees
 */
export const defaultFees: (estimate: StarknetRpc.StarknetFeeEstimate) => StarknetFees = feesWith(1.5)

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
const INVALID_TRANSACTION_NONCE = 52
const DUPLICATE_TX = 59
const refusals: ReadonlyMap<number | undefined, () => StarknetBroadcastReason> = new Map<
  number,
  () => StarknetBroadcastReason
>([
  [INVALID_TRANSACTION_NONCE, () => new InvalidNonce()],
  [53, () => new InsufficientResources()],
  [54, () => new InsufficientFunds()],
  [55, () => new ValidationFailure()],
  [64, () => new ReplacementUnderpriced()],
  [65, () => new InsufficientResources()]
])

// after a fallback, each endpoint's code in order
const codesOf = (error: StarknetRpc.StarknetRpcError): ReadonlyArray<number | undefined> =>
  JsonRpc.errorsOf(error).map((each) => each instanceof StarknetRpc.StarknetRpcError ? each.code : undefined)

// `TRANSACTION_EXECUTION_ERROR` of `starknet_estimateFee`, from any endpoint tried
const toSimulationError = (cause: StarknetRpc.StarknetRpcError) => {
  const refusal = JsonRpc.errorsOf(cause).find((each) =>
    each instanceof StarknetRpc.StarknetRpcError && each.code === 41
  )
  if (refusal === undefined) return cause
  const error = refusal.cause instanceof Error ? refusal.cause.message : refusal.message
  return new StarknetSimulationError({ reason: new SimulationFailed({ error }), cause })
}

const toSignerError = (cause: unknown) => new StarknetSignerError({ cause })

/**
 * Builds a {@link StarknetRelayer} over the provided {@link StarknetRpc.StarknetRpc}. `confirmations` overrides the
 * network's default, as in `StarknetIndexer.layer`: both agree on the last confirmed block. `fees` prices the
 * transactions signed without explicit fees: it defaults to {@link defaultFees} with `feeMultiplier` (default 1.5) as
 * its margin over the estimate.
 *
 * @since 0.3.0
 * @category layers
 */
export const layer = (options: {
  readonly confirmations?: number | undefined
  readonly fees?: ((estimate: StarknetRpc.StarknetFeeEstimate) => StarknetFees) | undefined
  readonly feeMultiplier?: number | undefined
} = {}): Layer.Layer<StarknetRelayer, never, StarknetRpc.StarknetRpc> =>
  Layer.effect(
    StarknetRelayer,
    Effect.gen(function*() {
      const rpc = yield* StarknetRpc.StarknetRpc
      const confirmations = options.confirmations ?? StarknetNetwork.defaultConfirmations(rpc.network)
      const chainId = StarknetNetwork.toChainId(rpc.network)
      const estimatedFees = options.fees ?? feesWith(options.feeMultiplier ?? 1.5)
      const estimate = (draft: StarknetUnsignedTransaction) =>
        rpc.estimateFee({ transactions: [{ ...draft, signature: [] }], skipValidate: true, blockTag: "pre_confirmed" })
          .pipe(
            Effect.mapError(toSimulationError),
            Effect.map(([estimate]) => {
              const { resourceBounds, tip } = estimatedFees(estimate)
              return { resourceBounds, tip, overallFee: estimate.overallFee }
            })
          )
      const finish = Effect.fnUntraced(function*(
        signer: StarknetSigner,
        draft: StarknetUnsignedTransaction,
        given: StarknetFees | undefined
      ) {
        const { resourceBounds, tip } = given ?? (yield* estimate(draft))
        const unsigned = { ...draft, resourceBounds, tip }
        const hash = yield* Effect.try({ try: () => transactionHash(unsigned), catch: toSignerError })
        const signature = yield* signer.signTransaction(unsigned)
        return { hash, signed: { ...unsigned, signature }, nonce: unsigned.nonce }
      })
      const unbounded = { resourceBounds: { l1Gas: NO_BOUND, l1DataGas: NO_BOUND, l2Gas: NO_BOUND }, tip: BigInt(0) }
      const invokeDraft = Effect.fnUntraced(function*(
        senderAddress: StarknetAddress,
        calls: ReadonlyArray<StarknetCall>,
        nonce: bigint | undefined
      ) {
        return {
          ...unbounded,
          type: "INVOKE" as const,
          chainId,
          senderAddress,
          calldata: executeCalldata(calls),
          nonce: nonce ?? (yield* rpc.getNonce({ address: senderAddress, blockTag: "pre_confirmed" }))
        }
      })
      const deployAccountDraft = Effect.fnUntraced(function*(
        { classHash, constructorCalldata, salt, signer }: Parameters<
          StarknetRelayer["Service"]["estimateDeployAccountFees"]
        >[0]
      ) {
        const draft = {
          ...unbounded,
          type: "DEPLOY_ACCOUNT" as const,
          chainId,
          classHash,
          contractAddressSalt: salt,
          constructorCalldata,
          nonce: BigInt(0)
        }
        const address = yield* Effect.try({ try: () => deployAddress(draft), catch: toSignerError })
        if (address !== signer.address) {
          return yield* toSignerError(new Error(`the account deploys at ${address}, the signer is ${signer.address}`))
        }
        return draft
      })
      const sign = Effect.fn("StarknetRelayer.sign")(
        function*({ calls, fees, nonce, signer }: Parameters<StarknetRelayer["Service"]["sign"]>[0]) {
          return yield* finish(signer, yield* invokeDraft(signer.address, calls, nonce), fees)
        }
      )
      const signDeployAccount = Effect.fn("StarknetRelayer.signDeployAccount")(
        function*(options: Parameters<StarknetRelayer["Service"]["signDeployAccount"]>[0]) {
          return yield* finish(options.signer, yield* deployAccountDraft(options), options.fees)
        }
      )
      const estimateFees = Effect.fn("StarknetRelayer.estimateFees")(
        function*(options: Parameters<StarknetRelayer["Service"]["estimateFees"]>[0]) {
          const address = "signer" in options ? options.signer.address : options.address
          return yield* estimate(yield* invokeDraft(address, options.calls, options.nonce))
        }
      )
      const estimateDeployAccountFees = Effect.fn("StarknetRelayer.estimateDeployAccountFees")(
        function*(options: Parameters<StarknetRelayer["Service"]["estimateDeployAccountFees"]>[0]) {
          return yield* estimate(yield* deployAccountDraft(options))
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
          // a transaction whose hash cannot be computed keeps the node's error
          const computed = Effect.try({ try: () => transactionHash(signed), catch: () => cause })
          if (codes.includes(DUPLICATE_TX)) return yield* computed
          // a node that has this transaction in a block answers that its nonce is used
          if (codes.includes(INVALID_TRANSACTION_NONCE)) {
            const hash = yield* computed
            if ((yield* rpc.getTransactionStatus({ transactionHash: hash })) !== null) return hash
          }
          const reason = refusals.get(codes.find((code) => refusals.has(code)))?.()
          return yield* reason === undefined ? cause : new StarknetBroadcastError({ reason, cause })
        }
      )
      const fetchTransactionStatus = Effect.fn("StarknetRelayer.fetchTransactionStatus")(
        function*({ hash }: StarknetTransactionStatusOptions) {
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
        estimateFees,
        estimateDeployAccountFees,
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

/**
 * Builds a {@link StarknetRelayer} like {@link layer}, reading the options from `Config`. The `fees` strategy is a
 * function: pass it to {@link layer}.
 *
 * @example
 * ```ts
 * import * as StarknetRelayer from "@effect-blockchain/starknet/StarknetRelayer"
 * import * as Config from "effect/Config"
 *
 * const RelayerLive = StarknetRelayer.layerConfig({ confirmations: Config.Int("STARKNET_CONFIRMATIONS") })
 * ```
 *
 * @since 0.3.0
 * @category layers
 */
export const layerConfig = (
  options: Config.Wrap<Omit<NonNullable<Parameters<typeof layer>[0]>, "fees">>
): Layer.Layer<StarknetRelayer, Config.ConfigError, StarknetRpc.StarknetRpc> =>
  Layer.unwrap(Effect.map(Config.unwrap(options), layer))
