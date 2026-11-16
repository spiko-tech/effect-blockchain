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
 * the priority fee only: the base fee of 5000 lamports per signature is charged on top.
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
 * import { type SolanaInstruction, SolanaRelayer } from "@effect-blockchain/solana/SolanaRelayer"
 * import type { SolanaSigner } from "@effect-blockchain/solana/SolanaSigner"
 * import type { SolanaTransactionHash } from "@effect-blockchain/solana/SolanaTransactionHash"
 * import * as Effect from "effect/Effect"
 *
 * declare const feePayer: SolanaSigner
 * declare const instructions: ReadonlyArray<SolanaInstruction>
 * declare const store: (hash: SolanaTransactionHash, lastValidBlockHeight: bigint) => Effect.Effect<void>
 *
 * const program = Effect.gen(function*() {
 *   const relayer = yield* SolanaRelayer
 *   const { hash, lastValidBlockHeight, signed } = yield* relayer.sign({ feePayer, instructions })
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
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Order from "effect/Order"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as Confirmations from "./internal/confirmations.ts"
import * as RpcMethods from "./internal/rpcMethods.ts"
import { SolanaAddress } from "./SolanaAddress.ts"
import { DEFAULT_POLL_INTERVAL } from "./SolanaIndexer.ts"
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
 * `hash` the fee payer's signature and `lastValidBlockHeight` the last block height it can land at.
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
 * The fee payer cannot pay the transaction fee: its balance is too low, or it holds no account.
 *
 * @since 0.2.0
 * @category reasons
 */
export class InsufficientFundsForFee
  extends Schema.TaggedError<InsufficientFundsForFee>()("InsufficientFundsForFee", {})
{}

const TransactionError: Schema.Codec<SolanaRpc.SolanaTransactionError> = Schema.toType(RpcMethods.TransactionError)

/**
 * The node simulated the transaction and it failed: `error` is the transaction error and `logs` the program logs up
 * to it. {@link SolanaRelayer.sign} fails with it when it estimates the compute unit limit.
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
export const SolanaBroadcastReason = Schema.Union([BlockhashNotFound, InsufficientFundsForFee, SimulationFailed])

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
 * @since 0.2.0
 * @category services
 */
export class SolanaRelayer extends Context.Service<SolanaRelayer, {
  /**
   * Signs a v0 transaction of `instructions` paid by `feePayer` without sending it. `signers` are the other accounts
   * the instructions mark as signer. A missing `blockhash` is the latest one at `confirmed` commitment, a missing
   * `computeUnitLimit` is the units a simulation consumed times the layer's `computeUnitMultiplier` (a transaction
   * that would fail fails with `SimulationFailed`), and a missing `computeUnitPrice`, in micro-lamports, comes from
   * the layer's fee strategy.
   */
  readonly sign: (options: {
    readonly feePayer: SolanaSigner
    readonly signers?: ReadonlyArray<SolanaSigner> | undefined
    readonly instructions: ReadonlyArray<SolanaInstruction>
    readonly blockhash?: Pick<SolanaRpc.SolanaLatestBlockhash, "blockhash" | "lastValidBlockHeight"> | undefined
    readonly computeUnitLimit?: number | undefined
    readonly computeUnitPrice?: bigint | undefined
  }) => Effect.Effect<SolanaSignedTransaction, SolanaRpc.SolanaRpcError | SolanaSignerError | SimulationFailed>
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
export const defaultFees = (fees: ReadonlyArray<SolanaRpc.SolanaPrioritizationFee>): bigint => {
  const sorted = Arr.sort(fees.map(({ prioritizationFee }) => prioritizationFee), Order.BigInt)
  return BigInt_.max(sorted[Math.floor(sorted.length * 0.75)] ?? PRIORITY_FEE_FLOOR, PRIORITY_FEE_FLOOR)
}

const COMPUTE_BUDGET_PROGRAM = SolanaAddress.make("ComputeBudget111111111111111111111111111111")

// the most a transaction can ask for, and what the simulation runs with
const MAX_COMPUTE_UNITS = 1_400_000

// `getRecentPrioritizationFees` takes at most 128 addresses
const MAX_FEE_ADDRESSES = 128

// `SetComputeUnitLimit` (discriminator 2, u32) and `SetComputeUnitPrice` (discriminator 3, u64), little-endian
const computeBudget = (limit: number, price: bigint): ReadonlyArray<SolanaInstruction> => {
  const unitLimit = new DataView(new ArrayBuffer(5))
  unitLimit.setUint8(0, 2)
  unitLimit.setUint32(1, limit, true)
  const unitPrice = new DataView(new ArrayBuffer(9))
  unitPrice.setUint8(0, 3)
  unitPrice.setBigUint64(1, price, true)
  return [
    { programAddress: COMPUTE_BUDGET_PROGRAM, data: new Uint8Array(unitLimit.buffer) },
    { programAddress: COMPUTE_BUDGET_PROGRAM, data: new Uint8Array(unitPrice.buffer) }
  ]
}

const roleOf = ({ signer = false, writable = false }: SolanaAccountMeta) =>
  signer
    ? (writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER)
    : (writable ? AccountRole.WRITABLE : AccountRole.READONLY)

const compile = (
  feePayer: SolanaAddress,
  lifetime: Pick<SolanaRpc.SolanaLatestBlockhash, "blockhash" | "lastValidBlockHeight">,
  instructions: ReadonlyArray<SolanaInstruction>
) =>
  Effect.try({
    try: () =>
      compileTransaction(pipe(
        createTransactionMessage({ version: 0 }),
        (message) => setTransactionMessageFeePayer(address(feePayer), message),
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
 * {@link defaultFees}) prices the transactions signed without a compute unit price, and `computeUnitMultiplier`
 * (default 1.2) is the margin applied to a simulated compute unit limit.
 *
 * @since 0.2.0
 * @category layers
 */
export const layer = (options: {
  readonly confirmations?: number | undefined
  readonly fees?: ((fees: ReadonlyArray<SolanaRpc.SolanaPrioritizationFee>) => bigint) | undefined
  readonly computeUnitMultiplier?: number | undefined
} = {}): Layer.Layer<SolanaRelayer, never, SolanaRpc.SolanaRpc> =>
  Layer.effect(
    SolanaRelayer,
    Effect.gen(function*() {
      const rpc = yield* SolanaRpc.SolanaRpc
      const sign = Effect.fn("SolanaRelayer.sign")(
        function*(
          { feePayer, instructions, signers = [], ...given }: Parameters<SolanaRelayer["Service"]["sign"]>[0]
        ) {
          const writable = Arr.dedupe([
            feePayer.address,
            ...instructions.flatMap(({ accounts = [] }) =>
              accounts.filter((account) => account.writable === true).map((account) => account.address)
            )
          ])
          const { lifetime, price } = yield* Effect.all({
            lifetime: given.blockhash === undefined
              ? rpc.getLatestBlockhash({ commitment: "confirmed" })
              : Effect.succeed(given.blockhash),
            price: given.computeUnitPrice === undefined
              ? Effect.map(
                rpc.getRecentPrioritizationFees({ addresses: writable.slice(0, MAX_FEE_ADDRESSES) }),
                options.fees ?? defaultFees
              )
              : Effect.succeed(given.computeUnitPrice)
          }, { concurrency: "unbounded" })
          const build = (limit: number) =>
            compile(feePayer.address, lifetime, [...computeBudget(limit, price), ...instructions])
          const estimate = Effect.gen(function*() {
            const simulation = yield* rpc.simulateTransaction({
              transaction: getBase64EncodedWireTransaction(yield* build(MAX_COMPUTE_UNITS)),
              commitment: "confirmed",
              sigVerify: false,
              replaceRecentBlockhash: true
            })
            if (simulation.err !== null) {
              return yield* new SimulationFailed({ error: simulation.err, logs: simulation.logs ?? [] })
            }
            const units = Number(simulation.unitsConsumed ?? MAX_COMPUTE_UNITS)
            return Math.min(MAX_COMPUTE_UNITS, Math.ceil(units * (options.computeUnitMultiplier ?? 1.2)))
          })
          const compiled = yield* build(given.computeUnitLimit ?? (yield* estimate))
          const message = Uint8Array.from(compiled.messageBytes)
          const required = Object.keys(compiled.signatures)
          const signatures = yield* Effect.forEach(required, (account) => {
            const signer = [feePayer, ...signers].find((signer) => signer.address === account)
            return signer === undefined
              ? Effect.fail(new SolanaSignerError({ cause: new Error(`no signer for ${account}`) }))
              : Effect.flatMap(signer.signTransactionMessage(message), (signature) =>
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
            ? new InsufficientFundsForFee()
            : new SimulationFailed({ error: err, logs: logs ?? [] })
          return yield* new SolanaBroadcastError({ reason, cause })
        }
      )
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
        sign,
        broadcast,
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
