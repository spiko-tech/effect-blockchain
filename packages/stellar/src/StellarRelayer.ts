/**
 * Signs transactions of classic operations or of one Soroban invocation, broadcasts them and follows them until they
 * are final, on top of {@link StellarRpc.StellarRpc}. The relayer keeps no state and `broadcast` is idempotent, as described in
 * [Concepts](https://github.com/spiko-tech/effect-blockchain/blob/main/docs/concepts.md#stateless-relayer).
 *
 * The fee per operation is a maximum: a ledger charges what its inclusion needed, at least the network minimum of 100
 * stroops per operation. A signed transaction can only enter a ledger up to its `maxLedger`: past it, signing again
 * with the same sequence number is safe. A node holds the transactions of the ledgers it retains, about 7 days by
 * default: past that, a transaction that succeeded reads `NotFound`, so store its final status.
 *
 * | status | meaning | final |
 * |---|---|---|
 * | `Pending` | never returned: Stellar RPC only knows the transactions of closed ledgers | no |
 * | `Included` | in ledger `block`, above the last confirmed ledger: only with a `confirmations` above 0 | no |
 * | `Confirmed` | succeeded in ledger `block`, at or below the last confirmed ledger | yes |
 * | `Failed` | failed in ledger `block`, at or below the last confirmed ledger: it paid its fee | yes |
 * | `Expired` | unknown to the node, whose latest ledger is above the transaction's `maxLedger` | yes |
 * | `NotFound` | unknown to the node: not in a ledger yet, never sent, or older than the node retains | no |
 *
 * @example
 * ```ts
 * import type { StellarAccountAddress } from "@effect-blockchain/stellar/StellarAddress"
 * import * as StellarRelayer from "@effect-blockchain/stellar/StellarRelayer"
 * import * as StellarRpc from "@effect-blockchain/stellar/StellarRpc"
 * import type { StellarSigner } from "@effect-blockchain/stellar/StellarSigner"
 * import type { StellarTransactionHash } from "@effect-blockchain/stellar/StellarTransactionHash"
 * import { Asset, Operation } from "@stellar/stellar-sdk"
 * import * as Config from "effect/Config"
 * import * as Effect from "effect/Effect"
 * import * as FetchHttpClient from "effect/http/FetchHttpClient"
 * import * as Layer from "effect/Layer"
 *
 * declare const signer: StellarSigner
 * declare const destination: StellarAccountAddress
 * declare const store: (hash: StellarTransactionHash, sequence: bigint, maxLedger: bigint) => Effect.Effect<void>
 *
 * const program = Effect.gen(function*() {
 *   const relayer = yield* StellarRelayer.StellarRelayer
 *   const payment = Operation.payment({ destination, asset: Asset.native(), amount: "1" }).toXdr("base64")
 *   const { hash, maxLedger, sequence, signed } = yield* relayer.sign({ signer, operations: [payment] })
 *   yield* store(hash, sequence, maxLedger)
 *   yield* relayer.broadcast({ signed })
 *   // `maxLedger` ends the wait with `Expired` when no ledger took the transaction, the timeout bounds the rest
 *   return yield* relayer.awaitConfirmation({ hash, maxLedger }).pipe(Effect.timeout("10 minutes"))
 * })
 *
 * const RpcLive = StellarRpc.layerConfig({
 *   network: Config.succeed("Stellar"),
 *   endpoints: Config.all([Config.all({ name: Config.succeed("main"), url: Config.Redacted("STELLAR_RPC_URL") })])
 * })
 *
 * const main = program.pipe(
 *   Effect.provide(StellarRelayer.layer().pipe(Layer.provide(RpcLive), Layer.provide(FetchHttpClient.layer)))
 * )
 * ```
 *
 * @since 0.2.0
 */
import * as Confirmations from "@effect-blockchain/core/Confirmations"
import {
  Account,
  Address,
  authorizeEntry,
  buildAuthorizationEntryPreimage,
  decodeAddressToMuxedAccount,
  encodeMuxedAccountToAddress,
  extractBaseAddress,
  FeeBumpTransaction,
  hash as sha256,
  Keypair,
  Operation,
  TransactionBuilder,
  xdr
} from "@stellar/stellar-sdk"
import type * as Arr from "effect/Array"
import * as BigInt_ from "effect/BigInt"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import { accountEntry } from "./internal/accountChange.ts"
import type { StellarAccountAddress } from "./StellarAddress.ts"
import * as StellarNetwork from "./StellarNetwork.ts"
import * as StellarRpc from "./StellarRpc.ts"
import { type StellarSigner, StellarSignerError } from "./StellarSigner.ts"
import { StellarTransactionHash } from "./StellarTransactionHash.ts"

/**
 * Why a transaction failed, from its result XDR: its result code and, when that is `txFailed`, the result code of each
 * operation in order, the ones that succeeded included. For a fee bump whose inner transaction failed
 * (`txFeeBumpInnerFailed`), both are those of the inner transaction. A code this version does not list is `undefined`.
 *
 * @since 0.2.0
 * @category models
 */
export interface StellarTransactionFailure {
  readonly code: StellarTransactionResultCode | undefined
  readonly operations: ReadonlyArray<StellarOperationResultCode | undefined>
}

/**
 * Where a transaction stands, by `_tag`: see the module's table. `block` is the sequence of the ledger holding it,
 * and `reason` is `undefined` when the result XDR cannot be decoded (a result code newer than the SDK).
 *
 * @since 0.2.0
 * @category models
 */
export type StellarTransactionStatus =
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Included"; readonly block: bigint }
  | { readonly _tag: "Confirmed"; readonly block: bigint }
  | { readonly _tag: "Failed"; readonly block: bigint; readonly reason: StellarTransactionFailure | undefined }
  | { readonly _tag: "Expired" }
  | { readonly _tag: "NotFound" }

/**
 * A transaction signed by {@link StellarRelayer.sign} or wrapped by `feeBump`: `signed` is the base64
 * `TransactionEnvelope` XDR `broadcast` takes, `hash` its transaction hash, `sequence` the sequence number it uses and
 * `maxLedger` the last ledger that can hold it, which `fetchTransactionStatus` and `awaitConfirmation` take.
 *
 * @since 0.2.0
 * @category models
 */
export interface StellarSignedTransaction {
  readonly hash: StellarTransactionHash
  readonly signed: string
  readonly sequence: bigint
  readonly maxLedger: bigint
}

/**
 * The fees of a transaction: `fee` is the most it pays per operation, in stroops, a fee bump counting as one more
 * operation. The resource fee of a Soroban invocation comes on top.
 *
 * @since 0.3.0
 * @category models
 */
export interface StellarFees {
  readonly fee: bigint
}

/**
 * What a fee strategy prices from: the recent inclusion fees of `getFeeStats`, those of Soroban transactions for an
 * invocation and of classic transactions otherwise.
 *
 * @since 0.3.0
 * @category models
 */
export type StellarFeeEstimate = StellarRpc.StellarFeeDistribution

/**
 * The transaction to look up: its `hash` and the `maxLedger` of its `ledgerBounds`. Without `maxLedger`, an unknown
 * transaction is `NotFound`, never `Expired`.
 *
 * @since 0.3.0
 * @category models
 */
export interface StellarTransactionStatusOptions {
  readonly hash: StellarTransactionHash
  readonly maxLedger?: bigint | undefined
}

/**
 * The relayer service. In the example, `signer` pays the fee of a transaction sent through a channel account, which
 * then only keeps its minimum balance.
 *
 * @example
 * ```ts
 * import { StellarRelayer } from "@effect-blockchain/stellar/StellarRelayer"
 * import type { StellarSigner } from "@effect-blockchain/stellar/StellarSigner"
 * import type * as Arr from "effect/Array"
 * import * as Effect from "effect/Effect"
 *
 * declare const signer: StellarSigner
 * declare const channel: StellarSigner
 * declare const operations: Arr.NonEmptyReadonlyArray<string>
 *
 * const program = Effect.gen(function*() {
 *   const relayer = yield* StellarRelayer
 *   const direct = yield* relayer.sign({ signer, channel, operations })
 *   const bumped = yield* relayer.feeBump({ signer, signed: direct.signed })
 *   yield* relayer.broadcast({ signed: bumped.signed })
 *   // the fee bump has its own hash, and the `maxLedger` of the transaction it wraps
 *   return yield* relayer.awaitConfirmation(bumped)
 * })
 * ```
 *
 * @since 0.2.0
 * @category services
 */
export class StellarRelayer extends Context.Service<StellarRelayer, {
  /**
   * Signs a transaction of `operations` (each a base64 `Operation` XDR, at most 100) from the account
   * `signer.address` without sending it. A missing `sequence` is the account's sequence number plus 1, missing `fees`
   * come from the layer's fee strategy, and a missing `maxLedger` is the latest ledger plus the layer's `validity`.
   *
   * A single `invokeHostFunction` operation is simulated. The transaction gets its footprint and resources from the
   * simulation, missing `fees` are estimated from the Soroban inclusion fees, and the resource fee is added on top,
   * multiplied by `resourceFeeMultiplier` (default the layer's) and rounded up. An
   * operation without authorization entries gets the ones the simulation returns. An entry of the address of `signer`
   * or of a cosigner is signed with its `signAuthEntry`, valid up to `maxLedger`, and the signed invocation is
   * simulated again for its resources; a cosigner signs the transaction only when it is the source of an operation.
   * Another entry fails with `UnsupportedAuth`: pass that operation with its signed entries, which are kept. Fails
   * with a {@link StellarSimulationError} when the simulation fails, or when it asks to restore an archived entry
   * first.
   *
   * A `channel` is another account lending its sequence number, so that one `signer` sends several transactions at
   * once: the transaction uses the channel's sequence number and pays the fee from its balance, the operations
   * without a source account get `signer.address`, and the channel signs before `signer`. The application chooses a
   * free channel and holds it until its transaction is final.
   * `cosigners` sign after them, for the operations whose source account is another account. The network refuses
   * a transaction carrying a signature it does not need (`txBadAuthExtra`).
   *
   * Fails with a `StellarSignerError` when an operation is not XDR, when the account does not exist and no
   * `sequence` is given, or when `resourceFeeMultiplier` is below 1.
   */
  readonly sign: (options: {
    readonly signer: StellarSigner
    readonly operations: Arr.NonEmptyReadonlyArray<string>
    readonly channel?: StellarSigner | undefined
    readonly cosigners?: ReadonlyArray<StellarSigner> | undefined
    readonly sequence?: bigint | undefined
    readonly fees?: StellarFees | undefined
    readonly maxLedger?: bigint | undefined
    readonly resourceFeeMultiplier?: number | undefined
  }) => Effect.Effect<
    StellarSignedTransaction,
    StellarRpc.StellarRpcError | StellarSignerError | StellarSimulationError
  >
  /**
   * Wraps the signed transaction `signed` in a fee bump paid and signed by `signer`, without sending it, and returns
   * its envelope and its own hash, the one to follow. Missing `fees` come from the layer's fee strategy, and are at
   * least the fee of `signed`, as the network requires.
   *
   * The fee bump has the `sequence` and `maxLedger` of `signed`, 0 for a `signed` without an upper ledger bound, which
   * never reads `Expired`. Fails with a `StellarSignerError` when `signed` is not a transaction envelope, or `fees`
   * are below its fee.
   *
   * The `@example` of {@link StellarRelayer} sends a channel's transaction with a fee bump.
   */
  readonly feeBump: (options: {
    readonly signer: StellarSigner
    readonly signed: string
    readonly fees?: StellarFees | undefined
  }) => Effect.Effect<StellarSignedTransaction, StellarRpc.StellarRpcError | StellarSignerError>
  /**
   * Sends a signed envelope with `sendTransaction` and returns its hash. Sending the same envelope again is safe: a
   * node that already holds the transaction, or has it in a ledger, is a success. `TRY_AGAIN_LATER` and a refusal
   * fail with a {@link StellarBroadcastError}.
   */
  readonly broadcast: (options: {
    readonly signed: string
  }) => Effect.Effect<StellarTransactionHash, StellarBroadcastError | StellarRpc.StellarRpcError>
  /**
   * The status of the transaction as the answering endpoint sees it. An endpoint behind the head, or one that no
   * longer retains the transaction's ledger, answers `NotFound` for a transaction another one has in a ledger.
   *
   * `maxLedger` is the upper bound of the transaction's `ledgerBounds`: with it, an unknown transaction is `Expired`
   * once the endpoint's latest ledger is above it, as no later ledger can hold it. It stays `NotFound` when the
   * endpoint retains no ledger up to `maxLedger`, and so cannot tell.
   */
  readonly fetchTransactionStatus: (
    options: StellarTransactionStatusOptions
  ) => Effect.Effect<StellarTransactionStatus, StellarRpc.StellarRpcError>
  /**
   * Reads {@link fetchTransactionStatus} on `poll` until it is `Confirmed`, `Failed` or `Expired`, and returns it.
   * `NotFound` keeps polling, so pass `maxLedger` or bound the wait with a timeout. `poll` and errors work as in
   * {@link Confirmations.awaitConfirmation}.
   */
  readonly awaitConfirmation: (
    options: StellarTransactionStatusOptions & { readonly poll?: Schedule.Schedule<unknown> | undefined }
  ) => Effect.Effect<StellarTransactionStatus, StellarRpc.StellarRpcError>
}>()("@effect-blockchain/stellar/StellarRelayer") {}

// a code the SDK decodes and the schemas do not list is dropped: a schema constructor would throw on it
const operationCode = (operation: xdr.OperationResult): StellarOperationResultCode | undefined => {
  const code: string = operation.type === "opInner" ? operation.tr.value.type : operation.type
  return isOperationResultCode(code) ? code : undefined
}

const failureOf = (resultXdr: string): StellarTransactionFailure | undefined => {
  try {
    const outer = xdr.TransactionResult.fromXdr(resultXdr, "base64").result
    const result = outer.type === "txFeeBumpInnerFailed" ? outer.innerResultPair.result.result : outer
    const code: string = result.type
    return {
      code: isTransactionResultCode(code) ? code : undefined,
      operations: result.type === "txFailed" ? result.results.map(operationCode) : []
    }
  } catch {
    return undefined
  }
}

/**
 * The default `poll` spacing of {@link StellarRelayer.Service.awaitConfirmation}: 10 seconds.
 *
 * @since 0.3.0
 * @category constants
 */
export const DEFAULT_POLL_INTERVAL: Duration.Duration = Confirmations.DEFAULT_POLL_INTERVAL

// the network's minimum base fee: https://developers.stellar.org/docs/learn/fundamentals/fees-resource-limits-metering
const MIN_FEE = BigInt(100)

/**
 * The library's fee strategy: the 90th percentile of the recent inclusion fees, at least the network's minimum of 100
 * stroops per operation.
 *
 * @since 0.2.0
 * @category fees
 */
export const defaultFees = (estimate: StellarFeeEstimate): StellarFees => ({
  fee: BigInt_.max(estimate.p90, MIN_FEE)
})

/**
 * The operations creating `account` with its reserve paid by `sponsor`, so that it needs no balance of its own, as
 * base64 `Operation` XDR for `sign`. Both accounts must sign: pass the signer of `account` as a cosigner.
 *
 * @since 0.2.0
 * @category operations
 */
export const createSponsoredAccount = (options: {
  readonly sponsor: StellarAccountAddress
  readonly account: StellarAccountAddress
}): readonly [string, string, string] => [
  Operation.beginSponsoringFutureReserves({ sponsoredId: options.account, source: options.sponsor }).toXdr("base64"),
  Operation.createAccount({ destination: options.account, startingBalance: "0", source: options.sponsor })
    .toXdr("base64"),
  Operation.endSponsoringFutureReserves({ source: options.account }).toXdr("base64")
]

const toSignerError = (cause: unknown) => new StellarSignerError({ cause })

const accountKey = (address: string) =>
  xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(address).xdrAccountId() }))
    .toXdr("base64")

/**
 * Builds a {@link StellarRelayer} over the provided {@link StellarRpc.StellarRpc}. `confirmations` overrides the
 * network's default (0), as in `StellarIndexer.layer`: both agree on the last confirmed ledger. `fees` (default
 * {@link defaultFees}) prices the transactions signed without `fees` from the inclusion fees of `getFeeStats`,
 * classic or Soroban, and `validity` (default 60, about 5 minutes) is the number of ledgers after the latest one
 * that a transaction signed without `maxLedger` can enter. `resourceFeeMultiplier` (default 1, at least 1, to the
 * hundredth) scales the simulated resource fee of a Soroban invocation, as a margin against
 * `invokeHostFunctionInsufficientRefundableFee`.
 *
 * @since 0.2.0
 * @category layers
 */
export const layer = (options: {
  readonly confirmations?: number | undefined
  readonly fees?: ((estimate: StellarFeeEstimate) => StellarFees) | undefined
  readonly validity?: number | undefined
  readonly resourceFeeMultiplier?: number | undefined
} = {}): Layer.Layer<StellarRelayer, never, StellarRpc.StellarRpc> =>
  Layer.effect(
    StellarRelayer,
    Effect.gen(function*() {
      const rpc = yield* StellarRpc.StellarRpc
      const confirmations = options.confirmations ?? StellarNetwork.defaultConfirmations(rpc.network)
      const networkPassphrase = StellarNetwork.toPassphrase(rpc.network)
      // Soroban and classic transactions compete for separate ledger space, each with its own fees
      const estimateFee = (soroban: boolean) =>
        Effect.map(
          rpc.getFeeStats,
          (stats) => (options.fees ?? defaultFees)(soroban ? stats.sorobanInclusionFee : stats.inclusionFee).fee
        )
      const hashOf = (envelope: string) =>
        Effect.try({
          try: () =>
            StellarTransactionHash.make(
              `0x${Buffer.from(TransactionBuilder.fromXdr(envelope, networkPassphrase).hash()).toString("hex")}`
            ),
          catch: toSignerError
        })
      const sign = Effect.fn("StellarRelayer.sign")(
        function*(
          { channel, cosigners = [], operations, signer, ...given }: Parameters<StellarRelayer["Service"]["sign"]>[0]
        ) {
          const multiplier = given.resourceFeeMultiplier ?? options.resourceFeeMultiplier ?? 1
          if (!(Number.isFinite(multiplier) && multiplier >= 1)) {
            return yield* new StellarSignerError({
              cause: new Error(`resourceFeeMultiplier ${multiplier} is not a finite number of at least 1`)
            })
          }
          const percent = BigInt(Math.round(multiplier * 100))
          const source = (channel ?? signer).address
          const parsed = yield* Effect.try({
            try: () =>
              operations.map((operation) => {
                const decoded = xdr.Operation.fromXdr(operation, "base64")
                // an operation without a source account acts for the source of the transaction: the channel
                return channel !== undefined && decoded.sourceAccount === null
                  ? new xdr.Operation({
                    sourceAccount: decodeAddressToMuxedAccount(signer.address),
                    body: decoded.body
                  })
                  : decoded
              }),
            catch: toSignerError
          })
          const [first] = parsed
          const invocation = parsed.length === 1 && first?.body.type === "invokeHostFunction"
            ? { operation: first, op: first.body.invokeHostFunctionOp }
            : undefined
          const [{ entries: [account], latestLedger }, fee] = yield* Effect.all([
            rpc.getLedgerEntries({ keys: [accountKey(source)] }),
            given.fees === undefined ? estimateFee(invocation !== undefined) : Effect.succeed(given.fees.fee)
          ], { concurrency: "unbounded" })
          const maxLedger = given.maxLedger ?? latestLedger + BigInt(options.validity ?? 60)
          const sequence = given.sequence ?? (account === undefined
            ? yield* new StellarSignerError({ cause: new Error(`account ${source} does not exist`) })
            : accountEntry(account.xdr).seqNum + BigInt(1))
          // the part of `resourceFee` above the non-refundable fees of `resources` is the refundable budget (rent,
          // events, return value), so the whole margin goes there: `SorobanTransactionData` in Stellar-transaction.x
          // https://github.com/stellar/stellar-xdr/blob/curr/Stellar-transaction.x
          const withMargin = (transactionData: string) => {
            const data = xdr.SorobanTransactionData.fromXdr(transactionData, "base64")
            return new xdr.SorobanTransactionData({
              ext: data.ext,
              resources: data.resources,
              resourceFee: (data.resourceFee * percent + BigInt(99)) / BigInt(100)
            })
          }
          const build = (operations: ReadonlyArray<xdr.Operation>, fee: bigint, sorobanData?: string) =>
            Effect.try({
              try: () => {
                // the builder signs with the sequence number after the account's
                const account = new Account(source, (sequence - BigInt(1)).toString())
                const builder = new TransactionBuilder(account, {
                  fee: fee.toString(),
                  networkPassphrase,
                  ledgerbounds: { minLedger: 0, maxLedger: Number(maxLedger) },
                  timebounds: { minTime: 0, maxTime: 0 },
                  ...(sorobanData === undefined ? {} : { sorobanData: withMargin(sorobanData) })
                })
                operations.forEach((operation) => builder.addOperation(operation))
                return builder.build().toEnvelope().toXdr("base64")
              },
              catch: toSignerError
            })
          const simulate = Effect.fnUntraced(function*(operations: ReadonlyArray<xdr.Operation>) {
            const simulation = yield* rpc.simulateTransaction({ transaction: yield* build(operations, fee) })
            if ("error" in simulation) {
              return yield* new StellarSimulationError({ reason: new SimulationFailed({ error: simulation.error }) })
            }
            // signed as is, the invocation would fail in a ledger on its archived entries and still pay its fee
            if (simulation.restorePreamble !== undefined) {
              return yield* new StellarSimulationError({ reason: new RestoreRequired(simulation.restorePreamble) })
            }
            return simulation
          })
          // the signers of address entries, which sign the transaction only as the source of an operation
          const authorizers = new Set<StellarSigner>()
          // the preimage of CAP-46-11 (https://github.com/stellar/stellar-protocol/blob/master/core/cap-0046-11.md),
          // signed as the `authorizeEntry` of `@stellar/stellar-sdk` signs for an account, valid up to `maxLedger`
          const authorize = Effect.fnUntraced(function*(entry: xdr.SorobanAuthorizationEntry) {
            if (entry.credentials.type === "sorobanCredentialsSourceAccount") return entry
            const address = entry.credentials.type === "sorobanCredentialsAddress"
              ? Address.fromScAddress(entry.credentials.address.address).toString()
              : undefined
            const authorizer = [signer, ...cosigners].find((each) => each.address === address)
            if (authorizer?.signAuthEntry === undefined) {
              return yield* new StellarSimulationError({ reason: new UnsupportedAuth() })
            }
            const validity = Number(maxLedger)
            const preimage = buildAuthorizationEntryPreimage(entry, validity, networkPassphrase)
            const signature = yield* authorizer.signAuthEntry({
              network: rpc.network,
              hash: sha256(preimage.toXdr())
            })
            authorizers.add(authorizer)
            return yield* Effect.tryPromise({
              // verifies the signature against the preimage and the address
              try: () =>
                authorizeEntry(
                  entry,
                  async () => ({ signature, publicKey: authorizer.address }),
                  validity,
                  networkPassphrase
                ),
              catch: toSignerError
            })
          })
          const prepare = Effect.fnUntraced(
            function*({ op, operation }: { operation: xdr.Operation; op: xdr.InvokeHostFunctionOp }) {
              const simulation = yield* simulate(parsed)
              // entries the caller built and signed are kept
              if (op.auth.length > 0) return yield* build(parsed, fee, simulation.transactionData)
              const auth = yield* Effect.forEach(
                simulation.results?.[0]?.auth ?? [],
                (entry) => authorize(xdr.SorobanAuthorizationEntry.fromXdr(entry, "base64"))
              )
              const authorized = new xdr.Operation({
                sourceAccount: operation.sourceAccount,
                body: xdr.OperationBody.invokeHostFunction(
                  new xdr.InvokeHostFunctionOp({ hostFunction: op.hostFunction, auth })
                )
              })
              // the first simulation ran on unsigned entries: the resources come from the entries that are sent, as
              // for entries the caller signed
              const resources = authorizers.size === 0 ? simulation : yield* simulate([authorized])
              // the builder adds the resource fee of `sorobanData` to the transaction's fee (`TransactionBuilder.build`)
              return yield* build([authorized], fee, resources.transactionData)
            }
          )
          const envelope = yield* (invocation === undefined ? build(parsed, fee) : prepare(invocation))
          const sources = new Set(
            parsed.flatMap(({ sourceAccount }) =>
              sourceAccount === null ? [] : [extractBaseAddress(encodeMuxedAccountToAddress(sourceAccount))]
            )
          )
          let signed = envelope
          for (const each of [...(channel === undefined ? [] : [channel]), signer, ...cosigners]) {
            // a signature the transaction does not need makes the network refuse it (`txBadAuthExtra`)
            if (authorizers.has(each) && each.address !== source && !sources.has(each.address)) continue
            signed = yield* each.signTransaction({ network: rpc.network, envelope: signed })
          }
          return { hash: yield* hashOf(signed), signed, sequence, maxLedger }
        }
      )
      const feeBump = Effect.fn("StellarRelayer.feeBump")(
        function*({ signed, signer, ...given }: Parameters<StellarRelayer["Service"]["feeBump"]>[0]) {
          const inner = yield* Effect.try({
            try: () => {
              const transaction = TransactionBuilder.fromXdr(signed, networkPassphrase)
              if (transaction instanceof FeeBumpTransaction) throw new Error("already a fee bump")
              return transaction
            },
            catch: toSignerError
          })
          const sorobanData = inner.tx instanceof xdr.Transaction && inner.tx.ext.type === "sorobanData"
            ? inner.tx.ext.sorobanData
            : undefined
          const count = BigInt(inner.operations.length)
          const resourceFee = sorobanData?.resourceFee ?? BigInt(0)
          // a fee bump must offer at least the inclusion fee per operation of its inner transaction (CAP-0015)
          const innerFee = (BigInt(inner.fee) - resourceFee + count - BigInt(1)) / count
          const fee = given.fees?.fee ?? BigInt_.max(innerFee, yield* estimateFee(sorobanData !== undefined))
          const envelope = yield* Effect.try({
            try: () =>
              TransactionBuilder.buildFeeBumpTransaction(signer.address, fee.toString(), inner, networkPassphrase)
                .toEnvelope().toXdr("base64"),
            catch: toSignerError
          })
          const bumped = yield* signer.signTransaction({ network: rpc.network, envelope })
          return {
            hash: yield* hashOf(bumped),
            signed: bumped,
            sequence: BigInt(inner.sequence),
            maxLedger: BigInt(inner.ledgerBounds?.maxLedger ?? 0)
          }
        }
      )
      const broadcast = Effect.fn("StellarRelayer.broadcast")(
        function*({ signed }: { readonly signed: string }) {
          const sent = yield* rpc.sendTransaction({ transaction: signed })
          if (sent.status === "PENDING" || sent.status === "DUPLICATE") return sent.hash
          const failure = failureOf(sent.errorResultXdr ?? "")
          const reason = sent.status === "TRY_AGAIN_LATER"
            ? new TryAgainLater()
            : failure?.code === "txBadSeq"
            ? new InvalidNonce()
            : failure?.code === "txInsufficientBalance"
            ? new InsufficientFunds()
            : new Refused({ code: failure?.code, operations: failure?.operations ?? [] })
          // a node that has this transaction in a ledger refuses its second copy: stellar-core answers
          // `TRY_AGAIN_LATER` for about 10 ledgers after applying it, then that its sequence number is used
          if (
            (reason._tag === "TryAgainLater" || reason._tag === "InvalidNonce") &&
            (yield* rpc.getTransaction({ hash: sent.hash })).status !== "NOT_FOUND"
          ) return sent.hash
          return yield* new StellarBroadcastError({
            reason,
            cause: new Error(`sendTransaction answered ${sent.status} ${sent.errorResultXdr ?? ""}`.trimEnd())
          })
        }
      )
      const fetchTransactionStatus = Effect.fn("StellarRelayer.fetchTransactionStatus")(
        ({ hash, maxLedger }: StellarTransactionStatusOptions) =>
          Effect.map(rpc.getTransaction({ hash }), (transaction): StellarTransactionStatus => {
            if (transaction.status === "NOT_FOUND") {
              // a node that has dropped every ledger up to `maxLedger` no longer knows a transaction that was in one
              return maxLedger !== undefined && transaction.latestLedger > maxLedger &&
                  transaction.oldestLedger <= maxLedger
                ? { _tag: "Expired" }
                : { _tag: "NotFound" }
            }
            const block = transaction.ledger
            // the latest ledger of the same reply: the endpoint that holds the transaction also sets the head
            if (
              block > Confirmations.lastConfirmedBlock(transaction.latestLedger, confirmations)
            ) return { _tag: "Included", block }
            return transaction.status === "SUCCESS"
              ? { _tag: "Confirmed", block }
              : { _tag: "Failed", block, reason: failureOf(transaction.resultXdr) }
          })
      )
      return StellarRelayer.of({
        sign,
        feeBump,
        broadcast,
        fetchTransactionStatus,
        awaitConfirmation: ({ poll, ...transaction }) =>
          Confirmations.awaitConfirmation({
            fetch: fetchTransactionStatus(transaction),
            isFinal: ({ _tag }) => _tag === "Confirmed" || _tag === "Failed" || _tag === "Expired",
            poll
          }).pipe(Effect.withSpan("StellarRelayer.awaitConfirmation"))
      })
    })
  )

/**
 * Builds a {@link StellarRelayer} like {@link layer}, reading `confirmations` and `validity` from `Config`. The fee
 * strategy is {@link defaultFees}: use {@link layer} for another one.
 *
 * @example
 * ```ts
 * import * as StellarRelayer from "@effect-blockchain/stellar/StellarRelayer"
 * import * as Config from "effect/Config"
 *
 * const RelayerLive = StellarRelayer.layerConfig({ validity: Config.Int("STELLAR_VALIDITY") })
 * ```
 *
 * @since 0.3.0
 * @category layers
 */
export const layerConfig = (
  options: Config.Wrap<Omit<NonNullable<Parameters<typeof layer>[0]>, "fees">>
): Layer.Layer<StellarRelayer, Config.ConfigError, StellarRpc.StellarRpc> =>
  Layer.unwrap(Effect.map(Config.unwrap(options), layer))

/**
 * The result code of a transaction, the XDR `TransactionResultCode` under the name `@stellar/stellar-sdk` gives it:
 * `txBadSeq` is `txBAD_SEQ`.
 *
 * @since 0.2.0
 * @category schemas
 */
// dprint-ignore
export const StellarTransactionResultCode = Schema.Literals([
  "txFeeBumpInnerSuccess", "txSuccess", "txFailed", "txTooEarly", "txTooLate", "txMissingOperation", "txBadSeq",
  "txBadAuth", "txInsufficientBalance", "txNoAccount", "txInsufficientFee", "txBadAuthExtra", "txInternalError",
  "txNotSupported", "txFeeBumpInnerFailed", "txBadSponsorship", "txBadMinSeqAgeOrGap", "txMalformed",
  "txSorobanInvalid", "txFrozenKeyAccessed"
])

/**
 * @since 0.2.0
 * @category models
 */
export type StellarTransactionResultCode = typeof StellarTransactionResultCode.Type

const isTransactionResultCode = Schema.is(StellarTransactionResultCode)

/**
 * The result code of one operation, under the name `@stellar/stellar-sdk` gives it: the code of its own type
 * (`paymentUnderfunded` is `PAYMENT_UNDERFUNDED`), or an `op` code when the operation was refused before its type was
 * looked at (`opNoAccount`).
 *
 * @since 0.2.0
 * @category schemas
 */
// dprint-ignore
export const StellarOperationResultCode = Schema.Literals([
  "opBadAuth", "opNoAccount", "opNotSupported", "opTooManySubentries", "opExceededWorkLimit", "opTooManySponsoring",
  "createAccountSuccess", "createAccountMalformed", "createAccountUnderfunded", "createAccountLowReserve",
  "createAccountAlreadyExist", "paymentSuccess", "paymentMalformed", "paymentUnderfunded", "paymentSrcNoTrust",
  "paymentSrcNotAuthorized", "paymentNoDestination", "paymentNoTrust", "paymentNotAuthorized", "paymentLineFull",
  "paymentNoIssuer", "pathPaymentStrictReceiveSuccess", "pathPaymentStrictReceiveMalformed",
  "pathPaymentStrictReceiveUnderfunded", "pathPaymentStrictReceiveSrcNoTrust",
  "pathPaymentStrictReceiveSrcNotAuthorized", "pathPaymentStrictReceiveNoDestination",
  "pathPaymentStrictReceiveNoTrust", "pathPaymentStrictReceiveNotAuthorized", "pathPaymentStrictReceiveLineFull",
  "pathPaymentStrictReceiveNoIssuer", "pathPaymentStrictReceiveTooFewOffers", "pathPaymentStrictReceiveOfferCrossSelf",
  "pathPaymentStrictReceiveOverSendmax", "manageSellOfferSuccess", "manageSellOfferMalformed",
  "manageSellOfferSellNoTrust", "manageSellOfferBuyNoTrust", "manageSellOfferSellNotAuthorized",
  "manageSellOfferBuyNotAuthorized", "manageSellOfferLineFull", "manageSellOfferUnderfunded",
  "manageSellOfferCrossSelf", "manageSellOfferSellNoIssuer", "manageSellOfferBuyNoIssuer", "manageSellOfferNotFound",
  "manageSellOfferLowReserve", "setOptionsSuccess", "setOptionsLowReserve", "setOptionsTooManySigners",
  "setOptionsBadFlags", "setOptionsInvalidInflation", "setOptionsCantChange", "setOptionsUnknownFlag",
  "setOptionsThresholdOutOfRange", "setOptionsBadSigner", "setOptionsInvalidHomeDomain",
  "setOptionsAuthRevocableRequired", "changeTrustSuccess", "changeTrustMalformed", "changeTrustNoIssuer",
  "changeTrustInvalidLimit", "changeTrustLowReserve", "changeTrustSelfNotAllowed", "changeTrustTrustLineMissing",
  "changeTrustCannotDelete", "changeTrustNotAuthMaintainLiabilities", "allowTrustSuccess", "allowTrustMalformed",
  "allowTrustNoTrustLine", "allowTrustTrustNotRequired", "allowTrustCantRevoke", "allowTrustSelfNotAllowed",
  "allowTrustLowReserve", "accountMergeSuccess", "accountMergeMalformed", "accountMergeNoAccount",
  "accountMergeImmutableSet", "accountMergeHasSubEntries", "accountMergeSeqnumTooFar", "accountMergeDestFull",
  "accountMergeIsSponsor", "inflationSuccess", "inflationNotTime", "manageDataSuccess", "manageDataNotSupportedYet",
  "manageDataNameNotFound", "manageDataLowReserve", "manageDataInvalidName", "bumpSequenceSuccess",
  "bumpSequenceBadSeq", "manageBuyOfferSuccess", "manageBuyOfferMalformed", "manageBuyOfferSellNoTrust",
  "manageBuyOfferBuyNoTrust", "manageBuyOfferSellNotAuthorized", "manageBuyOfferBuyNotAuthorized",
  "manageBuyOfferLineFull", "manageBuyOfferUnderfunded", "manageBuyOfferCrossSelf", "manageBuyOfferSellNoIssuer",
  "manageBuyOfferBuyNoIssuer", "manageBuyOfferNotFound", "manageBuyOfferLowReserve", "pathPaymentStrictSendSuccess",
  "pathPaymentStrictSendMalformed", "pathPaymentStrictSendUnderfunded", "pathPaymentStrictSendSrcNoTrust",
  "pathPaymentStrictSendSrcNotAuthorized", "pathPaymentStrictSendNoDestination", "pathPaymentStrictSendNoTrust",
  "pathPaymentStrictSendNotAuthorized", "pathPaymentStrictSendLineFull", "pathPaymentStrictSendNoIssuer",
  "pathPaymentStrictSendTooFewOffers", "pathPaymentStrictSendOfferCrossSelf", "pathPaymentStrictSendUnderDestmin",
  "createClaimableBalanceSuccess", "createClaimableBalanceMalformed", "createClaimableBalanceLowReserve",
  "createClaimableBalanceNoTrust", "createClaimableBalanceNotAuthorized", "createClaimableBalanceUnderfunded",
  "claimClaimableBalanceSuccess", "claimClaimableBalanceDoesNotExist", "claimClaimableBalanceCannotClaim",
  "claimClaimableBalanceLineFull", "claimClaimableBalanceNoTrust", "claimClaimableBalanceNotAuthorized",
  "claimClaimableBalanceTrustlineFrozen", "beginSponsoringFutureReservesSuccess",
  "beginSponsoringFutureReservesMalformed", "beginSponsoringFutureReservesAlreadySponsored",
  "beginSponsoringFutureReservesRecursive", "endSponsoringFutureReservesSuccess",
  "endSponsoringFutureReservesNotSponsored", "revokeSponsorshipSuccess", "revokeSponsorshipDoesNotExist",
  "revokeSponsorshipNotSponsor", "revokeSponsorshipLowReserve", "revokeSponsorshipOnlyTransferable",
  "revokeSponsorshipMalformed", "clawbackSuccess", "clawbackMalformed", "clawbackNotClawbackEnabled",
  "clawbackNoTrust", "clawbackUnderfunded", "clawbackClaimableBalanceSuccess", "clawbackClaimableBalanceDoesNotExist",
  "clawbackClaimableBalanceNotIssuer", "clawbackClaimableBalanceNotClawbackEnabled", "setTrustLineFlagsSuccess",
  "setTrustLineFlagsMalformed", "setTrustLineFlagsNoTrustLine", "setTrustLineFlagsCantRevoke",
  "setTrustLineFlagsInvalidState", "setTrustLineFlagsLowReserve", "liquidityPoolDepositSuccess",
  "liquidityPoolDepositMalformed", "liquidityPoolDepositNoTrust", "liquidityPoolDepositNotAuthorized",
  "liquidityPoolDepositUnderfunded", "liquidityPoolDepositLineFull", "liquidityPoolDepositBadPrice",
  "liquidityPoolDepositPoolFull", "liquidityPoolDepositTrustlineFrozen", "liquidityPoolWithdrawSuccess",
  "liquidityPoolWithdrawMalformed", "liquidityPoolWithdrawNoTrust", "liquidityPoolWithdrawUnderfunded",
  "liquidityPoolWithdrawLineFull", "liquidityPoolWithdrawUnderMinimum", "liquidityPoolWithdrawTrustlineFrozen",
  "invokeHostFunctionSuccess", "invokeHostFunctionMalformed", "invokeHostFunctionTrapped",
  "invokeHostFunctionResourceLimitExceeded", "invokeHostFunctionEntryArchived",
  "invokeHostFunctionInsufficientRefundableFee", "extendFootprintTtlSuccess", "extendFootprintTtlMalformed",
  "extendFootprintTtlResourceLimitExceeded", "extendFootprintTtlInsufficientRefundableFee", "restoreFootprintSuccess",
  "restoreFootprintMalformed", "restoreFootprintResourceLimitExceeded", "restoreFootprintInsufficientRefundableFee"
])

/**
 * @since 0.2.0
 * @category models
 */
export type StellarOperationResultCode = typeof StellarOperationResultCode.Type

const isOperationResultCode = Schema.is(StellarOperationResultCode)

/**
 * The node did not take the transaction and asks to send it again later: it already holds a transaction of this
 * account, or its queue is full.
 *
 * @since 0.2.0
 * @category reasons
 */
export class TryAgainLater extends Schema.TaggedError<TryAgainLater>()("TryAgainLater", {}) {}

/**
 * The account paying the fee cannot: its balance, less its reserve, is below the fee (`txInsufficientBalance`).
 *
 * @since 0.3.0
 * @category reasons
 */
export class InsufficientFunds extends Schema.TaggedError<InsufficientFunds>()("InsufficientFunds", {}) {}

/**
 * The sequence number is not the account's next one (`txBadSeq`): it is used, or ahead of the account's.
 *
 * @since 0.3.0
 * @category reasons
 */
export class InvalidNonce extends Schema.TaggedError<InvalidNonce>()("InvalidNonce", {}) {}

/**
 * The node refused the transaction for another reason: `code` is its result code (`txInsufficientFee`,
 * `txTooLate`...), `undefined` when the result XDR cannot be decoded or the code is not listed, and `operations` the
 * result code of each operation when the code is `txFailed`.
 *
 * @since 0.2.0
 * @category reasons
 */
export class Refused extends Schema.TaggedError<Refused>()("Refused", {
  code: Schema.UndefinedOr(StellarTransactionResultCode),
  operations: Schema.Array(Schema.UndefinedOr(StellarOperationResultCode))
}) {}

/**
 * Why a node did not accept a transaction, the `reason` of a {@link StellarBroadcastError}, matched with
 * `Effect.catchReason`.
 *
 * @since 0.2.0
 * @category reasons
 */
export const StellarBroadcastReason = Schema.Union([InsufficientFunds, InvalidNonce, TryAgainLater, Refused])

/**
 * @since 0.2.0
 * @category reasons
 */
export type StellarBroadcastReason = typeof StellarBroadcastReason.Type

/**
 * A node did not accept the transaction, for the `reason` it gave: `cause` holds its reply. A failed request stays a
 * `StellarRpcError`.
 *
 * @since 0.2.0
 * @category errors
 */
export class StellarBroadcastError extends Schema.TaggedError<StellarBroadcastError>()("StellarBroadcastError", {
  reason: StellarBroadcastReason,
  cause: Schema.Defect()
}) {}

/**
 * The simulation of the invocation failed: `error` is the node's message, with the contract's diagnostic.
 *
 * @since 0.2.0
 * @category reasons
 */
export class SimulationFailed extends Schema.TaggedError<SimulationFailed>()("SimulationFailed", {
  error: Schema.String
}) {}

/**
 * The invocation needs an authorization entry that no signer covers: its address is a contract, or an account that is
 * neither the signer nor a cosigner with `signAuthEntry`, or its credentials are not `sorobanCredentialsAddress`.
 * Pass the operation with its signed entries.
 *
 * @since 0.2.0
 * @category reasons
 */
export class UnsupportedAuth extends Schema.TaggedError<UnsupportedAuth>()("UnsupportedAuth", {}) {}

/**
 * The invocation touches archived entries, which a `restoreFootprint` operation must restore first: `transactionData`
 * is the base64 `SorobanTransactionData` XDR of that operation's transaction and `minResourceFee` its resource fee in
 * stroops.
 *
 * @since 0.3.0
 * @category reasons
 */
export class RestoreRequired extends Schema.TaggedError<RestoreRequired>()("RestoreRequired", {
  transactionData: Schema.String,
  minResourceFee: Schema.BigInt
}) {}

/**
 * A Soroban invocation could not be prepared for signing, for a `reason` matched with `Effect.catchReason`.
 *
 * @since 0.2.0
 * @category errors
 */
export class StellarSimulationError extends Schema.TaggedError<StellarSimulationError>()("StellarSimulationError", {
  reason: Schema.Union([SimulationFailed, UnsupportedAuth, RestoreRequired])
}) {}
