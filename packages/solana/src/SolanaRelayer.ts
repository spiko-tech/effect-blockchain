/**
 * Solana transaction relaying on top of {@link SolanaRpc.SolanaRpc}: signing a transaction, broadcasting it and
 * following it until it is final.
 *
 * A relayer here sends an account's own transactions and manages their fees, as OpenZeppelin Relayer does. It is not
 * a meta-transaction relayer paying for someone else's transaction. It keeps no state: storing signatures and their
 * `lastValidBlockHeight`, deciding when to resend and holding keys belong to the application. Solana has no nonce:
 * the recent blockhash plays that role, so concurrent senders from one address need no coordination, but two
 * transactions with the same instructions, signers, fees and blockhash are one transaction and land once.
 *
 * Only v0 transactions with a recent blockhash are sent: address lookup tables and durable nonces are not. `sign`
 * returns the transaction's signature before anything is broadcast, so it can be stored first, and `broadcast` can be
 * repeated with the same bytes.
 *
 * Every transaction starts with the two Compute Budget instructions. Unless `sign` receives them, the compute unit
 * limit is what a simulation consumed times the layer's `computeUnitMultiplier`, and the compute unit price comes from
 * `getRecentPrioritizationFees` for the accounts the transaction writes to (see {@link defaultFees}). The price sets
 * the priority fee only: the base fee of 5000 lamports per signature is charged on top. A compute unit limit that is
 * not an integer from 0 to 1,400,000, or a price that is not a u64, fails `sign` with a `SolanaSignerError`.
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
 * blockhash. `Expired` is reported when the caller passes that height, a `finalized` block is above it, and the
 * endpoint that then did not know the transaction answered at that block's slot or later: an endpoint behind it
 * answers `NotFound`, so a transaction that can still land, or that a lagging endpoint cannot see yet, is never
 * `Expired`.
 * A durable-nonce transaction does not expire: leave `lastValidBlockHeight` out.
 *
 * @example
 * ```ts
 * import { type SolanaInstruction, SolanaRelayer } from "@effect-blockchain/solana/SolanaRelayer"
 * import type { SolanaSigner } from "@effect-blockchain/solana/SolanaSigner"
 * import type { SolanaTransactionHash } from "@effect-blockchain/solana/SolanaTransactionHash"
 * import type * as Arr from "effect/Array"
 * import * as Effect from "effect/Effect"
 *
 * declare const signer: SolanaSigner
 * declare const instructions: Arr.NonEmptyReadonlyArray<SolanaInstruction>
 * declare const store: (hash: SolanaTransactionHash, lastValidBlockHeight: bigint) => Effect.Effect<void>
 *
 * const program = Effect.gen(function*() {
 *   const relayer = yield* SolanaRelayer
 *   const { hash, lastValidBlockHeight, signed } = yield* relayer.sign({ signer, instructions })
 *   // stored before the broadcast: a crash in between leaves a signature to look up, never an unknown transaction
 *   yield* store(hash, lastValidBlockHeight)
 *   yield* relayer.broadcast({ signed })
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
import * as Confirmations from "@effect-blockchain/core/Confirmations"
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  assertIsSignatureBytes,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE
} from "@solana/kit"
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
import * as RpcMethods from "./internal/rpcMethods.ts"
import { SolanaAddress } from "./SolanaAddress.ts"
import * as SolanaNetwork from "./SolanaNetwork.ts"
import * as SolanaRpc from "./SolanaRpc.ts"
import { type SolanaSigner, SolanaSignerError } from "./SolanaSigner.ts"
import { SolanaTransactionHash } from "./SolanaTransactionHash.ts"

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
 * An account an instruction reads, `writable` when the instruction changes it and `signer` when it must sign the
 * transaction.
 *
 * @since 0.2.0
 * @category models
 */
export interface SolanaAccountMeta {
  readonly address: SolanaAddress
  readonly signer?: boolean | undefined
  readonly writable?: boolean | undefined
}

/**
 * An instruction of a transaction: the program to call, the accounts it takes, in the program's order, and its `data`
 * as the program encodes it.
 *
 * @since 0.2.0
 * @category models
 */
export interface SolanaInstruction {
  readonly programAddress: SolanaAddress
  readonly accounts?: ReadonlyArray<SolanaAccountMeta> | undefined
  readonly data?: Uint8Array | undefined
}

/**
 * A transaction signed by {@link SolanaRelayer.sign}: `signed` is the base64 wire transaction `broadcast` takes,
 * `hash` the signature of its `signer` and `lastValidBlockHeight` the last block height it can land at.
 *
 * @since 0.2.0
 * @category models
 */
export interface SolanaSignedTransaction {
  readonly hash: SolanaTransactionHash
  readonly signed: string
  readonly lastValidBlockHeight: bigint
}

/**
 * The node does not know the transaction's blockhash: it has expired, or the node is behind the one that returned
 * it. Past `lastValidBlockHeight`, sign the transaction again.
 *
 * @since 0.2.0
 * @category reasons
 */
export class BlockhashNotFound extends Schema.TaggedError<BlockhashNotFound>()("BlockhashNotFound", {}) {}

/**
 * The signer cannot pay the transaction fee: its balance is too low, or it holds no account.
 *
 * @since 0.3.0
 * @category reasons
 */
export class InsufficientFunds extends Schema.TaggedError<InsufficientFunds>()("InsufficientFunds", {}) {}

const TransactionError: Schema.Codec<SolanaRpc.SolanaTransactionError> = Schema.toType(RpcMethods.TransactionError)

/**
 * The node simulated the transaction and it failed: `error` is the transaction error and `logs` the program logs up
 * to it.
 *
 * @since 0.2.0
 * @category reasons
 */
export class SimulationFailed extends Schema.TaggedError<SimulationFailed>()("SimulationFailed", {
  error: TransactionError,
  logs: Schema.Array(Schema.String)
}) {}

/**
 * Why a node refused a transaction, the `reason` of a {@link SolanaBroadcastError}, matched with `Effect.catchReason`.
 *
 * @since 0.2.0
 * @category reasons
 */
export const SolanaBroadcastReason = Schema.Union([BlockhashNotFound, InsufficientFunds, SimulationFailed])

/**
 * @since 0.2.0
 * @category reasons
 */
export type SolanaBroadcastReason = typeof SolanaBroadcastReason.Type

/**
 * A node refused the transaction at its preflight simulation for a `reason` the sender can act on: `cause` is the
 * {@link SolanaRpc.SolanaRpcError} holding the node's message. Any other refusal stays a `SolanaRpcError`.
 *
 * @since 0.2.0
 * @category errors
 */
export class SolanaBroadcastError extends Schema.TaggedError<SolanaBroadcastError>()("SolanaBroadcastError", {
  reason: SolanaBroadcastReason,
  cause: Schema.Defect()
}) {}

/**
 * Why a transaction cannot be signed as it would run, the `reason` of a {@link SolanaSimulationError}, matched with
 * `Effect.catchReason`.
 *
 * @since 0.3.0
 * @category reasons
 */
export const SolanaSimulationReason = Schema.Union([SimulationFailed])

/**
 * @since 0.3.0
 * @category reasons
 */
export type SolanaSimulationReason = typeof SolanaSimulationReason.Type

/**
 * The simulation {@link SolanaRelayer.sign} runs to estimate the compute unit limit shows the transaction would fail,
 * for `reason`. Nothing was signed.
 *
 * @since 0.3.0
 * @category errors
 */
export class SolanaSimulationError extends Schema.TaggedError<SolanaSimulationError>()("SolanaSimulationError", {
  reason: SolanaSimulationReason
}) {}

/**
 * The fees of a transaction: `computeUnitPrice`, in micro-lamports per compute unit, sets its priority fee.
 *
 * @since 0.3.0
 * @category fees
 */
export interface SolanaFees {
  readonly computeUnitPrice: bigint
}

/**
 * What a fee strategy prices a transaction from: the `getRecentPrioritizationFees` of the accounts it writes to.
 *
 * @since 0.3.0
 * @category fees
 */
export interface SolanaFeeEstimate {
  readonly prioritizationFees: ReadonlyArray<SolanaRpc.SolanaPrioritizationFee>
}

/**
 * @since 0.2.0
 * @category services
 */
export class SolanaRelayer extends Context.Service<SolanaRelayer, {
  /**
   * Signs a v0 transaction of `instructions` without sending it: `signer` pays its fee and signs first, `cosigners`
   * are the other accounts the instructions mark as signer. A missing `blockhash` is the latest one at `confirmed`
   * commitment, a missing `computeUnitLimit` is the units a simulation consumed times the layer's
   * `computeUnitMultiplier` (a transaction that would fail fails with a `SimulationFailed` reason), and missing `fees`
   * come from the layer's fee strategy.
   */
  readonly sign: (options: {
    readonly signer: SolanaSigner
    readonly cosigners?: ReadonlyArray<SolanaSigner> | undefined
    readonly instructions: Arr.NonEmptyReadonlyArray<SolanaInstruction>
    readonly blockhash?: Pick<SolanaRpc.SolanaLatestBlockhash, "blockhash" | "lastValidBlockHeight"> | undefined
    readonly fees?: SolanaFees | undefined
    readonly computeUnitLimit?: number | undefined
  }) => Effect.Effect<SolanaSignedTransaction, SolanaRpc.SolanaRpcError | SolanaSignerError | SolanaSimulationError>
  /**
   * Sends a signed transaction with `sendTransaction` and returns its hash. The node simulates it first at
   * `confirmed` commitment, then rebroadcasts it to the leaders until its blockhash expires (the node's default
   * `maxRetries`). Sending the same bytes again is safe: a node answering that it has already processed the
   * transaction is a success.
   */
  readonly broadcast: (options: {
    readonly signed: string
  }) => Effect.Effect<SolanaTransactionHash, SolanaBroadcastError | SolanaRpc.SolanaRpcError>
  /**
   * The status of the transaction as the answering endpoint sees it. An endpoint behind the head, or one that never
   * received the transaction, answers `NotFound` for a transaction another one has in a block.
   */
  readonly fetchTransactionStatus: (
    options: SolanaTransactionStatusOptions
  ) => Effect.Effect<SolanaTransactionStatus, SolanaRpc.SolanaRpcError>
  /**
   * Reads {@link fetchTransactionStatus} on `poll` (`Schedule.spaced(DEFAULT_POLL_INTERVAL)` by default) until it is
   * `Confirmed`, `Failed` or `Expired`, and returns it. `NotFound` keeps polling, so bound the wait with a timeout. A
   * read failing with a transient reason (`JsonRpc.isTransient`) is read again on `poll`, any other error fails the
   * wait. A `poll` that ends first returns the last read.
   */
  readonly awaitConfirmation: (
    options: SolanaTransactionStatusOptions & { readonly poll?: Schedule.Schedule<unknown> | undefined }
  ) => Effect.Effect<SolanaTransactionStatus, SolanaRpc.SolanaRpcError>
}>()("@effect-blockchain/solana/SolanaRelayer") {}

/**
 * The default `poll` spacing of {@link SolanaRelayer.Service.awaitConfirmation}: 10 seconds.
 *
 * @since 0.3.0
 * @category constants
 */
export const DEFAULT_POLL_INTERVAL: Duration.Duration = Confirmations.DEFAULT_POLL_INTERVAL

// a slot reports the lowest price that landed in it, 0 as soon as one transaction paid none: any price above 0 is
// ordered before those transactions
const PRIORITY_FEE_FLOOR = BigInt(1)

/**
 * The library's fee strategy: the compute unit price is the 75th percentile of the recent slots' prioritization fees,
 * at least 1 micro-lamport.
 *
 * @since 0.2.0
 * @category fees
 */
export const defaultFees = ({ prioritizationFees }: SolanaFeeEstimate): SolanaFees => {
  const sorted = Arr.sort(prioritizationFees.map(({ prioritizationFee }) => prioritizationFee), Order.BigInt)
  return {
    computeUnitPrice: BigInt_.max(sorted[Math.floor(sorted.length * 0.75)] ?? PRIORITY_FEE_FLOOR, PRIORITY_FEE_FLOOR)
  }
}

const COMPUTE_BUDGET_PROGRAM = SolanaAddress.make("ComputeBudget111111111111111111111111111111")

// the most a transaction can ask for, and what the simulation runs with
const MAX_COMPUTE_UNITS = 1_400_000

// `getRecentPrioritizationFees` takes at most 128 addresses
const MAX_FEE_ADDRESSES = 128

const invalid = (message: string) => Effect.fail(new SolanaSignerError({ cause: new Error(message) }))

// `SetComputeUnitLimit` (discriminator 2, u32) and `SetComputeUnitPrice` (discriminator 3, u64), little-endian. The
// values are checked first: `DataView` wraps an out-of-range number and throws on an out-of-range bigint
const computeBudget = (
  limit: number,
  price: bigint
): Effect.Effect<ReadonlyArray<SolanaInstruction>, SolanaSignerError> => {
  if (!Number.isInteger(limit) || limit < 0 || limit > MAX_COMPUTE_UNITS) {
    return invalid(`computeUnitLimit ${limit} is not an integer from 0 to ${MAX_COMPUTE_UNITS}`)
  }
  if (BigInt.asUintN(64, price) !== price) return invalid(`computeUnitPrice ${price} is not a u64`)
  const unitLimit = new DataView(new ArrayBuffer(5))
  unitLimit.setUint8(0, 2)
  unitLimit.setUint32(1, limit, true)
  const unitPrice = new DataView(new ArrayBuffer(9))
  unitPrice.setUint8(0, 3)
  unitPrice.setBigUint64(1, price, true)
  return Effect.succeed([
    { programAddress: COMPUTE_BUDGET_PROGRAM, data: new Uint8Array(unitLimit.buffer) },
    { programAddress: COMPUTE_BUDGET_PROGRAM, data: new Uint8Array(unitPrice.buffer) }
  ])
}

const roleOf = ({ signer = false, writable = false }: SolanaAccountMeta) =>
  signer
    ? (writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER)
    : (writable ? AccountRole.WRITABLE : AccountRole.READONLY)

const compile = (
  signer: SolanaAddress,
  lifetime: Pick<SolanaRpc.SolanaLatestBlockhash, "blockhash" | "lastValidBlockHeight">,
  instructions: ReadonlyArray<SolanaInstruction>
) =>
  Effect.try({
    try: () =>
      compileTransaction(pipe(
        createTransactionMessage({ version: 0 }),
        (message) => setTransactionMessageFeePayer(address(signer), message),
        (message) =>
          setTransactionMessageLifetimeUsingBlockhash({
            blockhash: blockhash(lifetime.blockhash),
            lastValidBlockHeight: lifetime.lastValidBlockHeight
          }, message),
        (message) =>
          appendTransactionMessageInstructions(
            instructions.map(({ accounts = [], data, programAddress }) => ({
              programAddress: address(programAddress),
              accounts: accounts.map((account) => ({ address: address(account.address), role: roleOf(account) })),
              ...(data === undefined ? {} : { data })
            })),
            message
          )
      )),
    catch: (cause) => new SolanaSignerError({ cause })
  })

/**
 * Builds a {@link SolanaRelayer} over the provided {@link SolanaRpc.SolanaRpc}. `confirmations` overrides the
 * network's default, as in `SolanaIndexer.layer`: both agree on the last confirmed slot. `fees` (default
 * {@link defaultFees}) prices the transactions signed without `fees`, and `computeUnitMultiplier` (default 1.2) is
 * the margin applied to a simulated compute unit limit.
 *
 * @since 0.2.0
 * @category layers
 */
export const layer = (options: {
  readonly confirmations?: number | undefined
  readonly fees?: ((estimate: SolanaFeeEstimate) => SolanaFees) | undefined
  readonly computeUnitMultiplier?: number | undefined
} = {}): Layer.Layer<SolanaRelayer, never, SolanaRpc.SolanaRpc> =>
  Layer.effect(
    SolanaRelayer,
    Effect.gen(function*() {
      const rpc = yield* SolanaRpc.SolanaRpc
      const confirmations = options.confirmations ?? SolanaNetwork.defaultConfirmations(rpc.network)
      const sign = Effect.fn("SolanaRelayer.sign")(
        function*(
          { cosigners = [], instructions, signer, ...given }: Parameters<SolanaRelayer["Service"]["sign"]>[0]
        ) {
          const writable = Arr.dedupe([
            signer.address,
            ...instructions.flatMap(({ accounts = [] }) =>
              accounts.filter((account) => account.writable === true).map((account) => account.address)
            )
          ])
          const { fees, lifetime } = yield* Effect.all({
            lifetime: given.blockhash === undefined
              ? rpc.getLatestBlockhash({ commitment: "confirmed" })
              : Effect.succeed(given.blockhash),
            fees: given.fees === undefined
              ? Effect.map(
                rpc.getRecentPrioritizationFees({ addresses: writable.slice(0, MAX_FEE_ADDRESSES) }),
                (prioritizationFees) => (options.fees ?? defaultFees)({ prioritizationFees })
              )
              : Effect.succeed(given.fees)
          }, { concurrency: "unbounded" })
          const build = (limit: number) =>
            Effect.flatMap(
              computeBudget(limit, fees.computeUnitPrice),
              (budget) => compile(signer.address, lifetime, [...budget, ...instructions])
            )
          const estimate = Effect.gen(function*() {
            const simulation = yield* rpc.simulateTransaction({
              transaction: getBase64EncodedWireTransaction(yield* build(MAX_COMPUTE_UNITS)),
              commitment: "confirmed",
              sigVerify: false,
              replaceRecentBlockhash: true
            })
            if (simulation.err !== null) {
              return yield* new SolanaSimulationError({
                reason: new SimulationFailed({ error: simulation.err, logs: simulation.logs ?? [] })
              })
            }
            const units = Number(simulation.unitsConsumed ?? MAX_COMPUTE_UNITS)
            return Math.min(MAX_COMPUTE_UNITS, Math.ceil(units * (options.computeUnitMultiplier ?? 1.2)))
          })
          const compiled = yield* build(given.computeUnitLimit ?? (yield* estimate))
          const message = Uint8Array.from(compiled.messageBytes)
          const required = Object.keys(compiled.signatures)
          const signatures = yield* Effect.forEach(required, (account) => {
            const found = [signer, ...cosigners].find((candidate) => candidate.address === account)
            return found === undefined
              ? invalid(`no signer for ${account}`)
              : Effect.flatMap(found.signTransactionMessage(message), (signature) =>
                Effect.try({
                  try: () => {
                    assertIsSignatureBytes(signature)
                    return signature
                  },
                  catch: (cause) => new SolanaSignerError({ cause })
                }))
          }, { concurrency: "unbounded" })
          const transaction = { ...compiled, signatures: Object.fromEntries(Arr.zip(required, signatures)) }
          return {
            hash: SolanaTransactionHash.make(getSignatureFromTransaction(transaction)),
            signed: getBase64EncodedWireTransaction(transaction),
            lastValidBlockHeight: lifetime.lastValidBlockHeight
          }
        }
      )
      const broadcast = Effect.fn("SolanaRelayer.broadcast")(
        function*({ signed }: { readonly signed: string }) {
          // the blockhash is read at `confirmed`: a preflight at the default `finalized` would not know it yet
          const sent = yield* Effect.result(
            rpc.sendTransaction({ transaction: signed, preflightCommitment: "confirmed" })
          )
          if (sent._tag === "Success") return sent.success
          const cause = sent.failure
          if (cause.code !== SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE) {
            return yield* cause
          }
          // the JSON-RPC error only carries a message: the simulation run again returns the transaction error
          const { err, logs } = yield* rpc.simulateTransaction({
            transaction: signed,
            commitment: "confirmed",
            sigVerify: true
          })
          if (err === null) return yield* cause
          if (err === "AlreadyProcessed") {
            return SolanaTransactionHash.make(
              getSignatureFromTransaction(getTransactionDecoder().decode(getBase64Encoder().encode(signed)))
            )
          }
          const reason = err === "BlockhashNotFound"
            ? new BlockhashNotFound()
            // `AccountNotFound` is the fee payer's: the only account a transaction needs to exist
            : err === "InsufficientFundsForFee" || err === "AccountNotFound"
            ? new InsufficientFunds()
            : new SimulationFailed({ error: err, logs: logs ?? [] })
          return yield* new SolanaBroadcastError({ reason, cause })
        }
      )
      const fetchTransactionStatus = Effect.fn("SolanaRelayer.fetchTransactionStatus")(
        function*({ hash, lastValidBlockHeight }: SolanaTransactionStatusOptions) {
          // read before the status: a finalized block above `lastValidBlockHeight` closes the transaction's window
          const closing = lastValidBlockHeight === undefined
            ? undefined
            : yield* rpc.getEpochInfo({ commitment: "finalized" }).pipe(
              Effect.map((finalized) =>
                finalized.blockHeight > lastValidBlockHeight ? finalized.absoluteSlot : undefined
              )
            )
          // the node's status cache only covers recent slots: without the history, an old transaction would be unknown
          const { slot, value } = yield* rpc.getSignatureStatuses({
            signatures: [hash],
            searchTransactionHistory: true
          })
          const status = value[0] ?? null
          if (status === null) {
            // the two reads can come from different nodes: the status proves the transaction is in none of the blocks
            // of its window only when the node answering it, at `slot`, had reached the block closing that window
            return closing !== undefined && slot >= closing
              ? { _tag: "Expired" } as const
              : { _tag: "NotFound" } as const
          }
          const block = status.slot
          if (status.confirmationStatus !== "finalized") return { _tag: "Included", block } as const
          // read after the status: a finalized slot older than the transaction's could only delay `Confirmed`
          if (
            block > Confirmations.lastConfirmedBlock(yield* rpc.getSlot({ commitment: "finalized" }), confirmations)
          ) {
            return { _tag: "Included", block } as const
          }
          return status.err === null
            ? { _tag: "Confirmed", block } as const
            : { _tag: "Failed", block, reason: status.err } as const
        }
      )
      return SolanaRelayer.of({
        sign,
        broadcast,
        fetchTransactionStatus,
        awaitConfirmation: ({ poll, ...transaction }) =>
          Confirmations.awaitConfirmation({
            fetch: fetchTransactionStatus(transaction),
            isFinal: ({ _tag }) => _tag === "Confirmed" || _tag === "Failed" || _tag === "Expired",
            poll
          }).pipe(Effect.withSpan("SolanaRelayer.awaitConfirmation"))
      })
    })
  )

/**
 * Builds a {@link SolanaRelayer} like {@link layer}, reading `confirmations` and `computeUnitMultiplier` from
 * `Config`. The fee strategy is {@link defaultFees}.
 *
 * @example
 * ```ts
 * import * as SolanaRelayer from "@effect-blockchain/solana/SolanaRelayer"
 * import * as Config from "effect/Config"
 *
 * const RelayerLive = SolanaRelayer.layerConfig({ confirmations: Config.Int("SOLANA_CONFIRMATIONS") })
 * ```
 *
 * @since 0.3.0
 * @category layers
 */
export const layerConfig = (
  options: Config.Wrap<Omit<NonNullable<Parameters<typeof layer>[0]>, "fees">>
): Layer.Layer<SolanaRelayer, Config.ConfigError, SolanaRpc.SolanaRpc> =>
  Layer.unwrap(Effect.map(Config.unwrap(options), layer))
