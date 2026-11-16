/**
 * Stellar transaction relaying on top of {@link StellarRpc.StellarRpc}: signing a transaction, broadcasting it and
 * following it until it is final.
 *
 * A relayer here sends an account's own transactions and manages their sequence numbers and fees, as OpenZeppelin
 * Relayer does. It is not a relayer paying for someone else's transaction. It keeps no state: storing hashes and
 * sequence numbers, deciding when to resend and holding keys belong to the application. Senders sharing an account
 * must each pass their own sequence number, as the account's sequence number does not move until a transaction is in
 * a ledger, and two concurrent `sign` calls read the same one.
 *
 * A transaction holds classic operations, or one Soroban invocation, which `sign` simulates first for its footprint,
 * its resource fee and its authorization entries. Contract upload and deployment, the restoration of archived entries
 * and entries another account must sign are not handled. `sign` returns the transaction
 * hash before anything is broadcast, so it can be stored first, and `broadcast` can be repeated with the same
 * envelope. A signed transaction can only enter a ledger up to its `maxLedger`: past it, signing again with the same
 * sequence number is safe.
 *
 * The fee per operation comes from `getFeeStats` (see {@link defaultFees}) unless `sign` receives it. It is a
 * maximum: a ledger charges what its inclusion needed, 100 stroops per operation outside of surge pricing.
 *
 * A transaction is in one {@link StellarTransactionStatus}:
 *
 * | status | meaning | final |
 * |---|---|---|
 * | `Pending` | never reported: Stellar RPC only knows the transactions of closed ledgers | no |
 * | `Included` | in ledger `block`, above the last confirmed ledger: only with a `confirmations` above 0 | no |
 * | `Confirmed` | succeeded in ledger `block`, at or below the last confirmed ledger | yes |
 * | `Failed` | failed in ledger `block`, at or below the last confirmed ledger | yes |
 * | `Expired` | unknown to the node, whose latest ledger is above the transaction's `maxLedger` | yes |
 * | `NotFound` | unknown to the node: not in a ledger yet, never sent, or older than the node retains | no |
 *
 * Stellar closes a ledger about every 5 seconds and never reverts one, so a transaction is `NotFound` until its ledger
 * closes, then `Confirmed` or `Failed`. A failed transaction is in a ledger like a successful one: it has consumed
 * its sequence number and paid its fee, so sending it again needs a new sequence number.
 *
 * An RPC node only holds the transactions of the ledgers it retains (about 7 days by default, less on some
 * providers): past that, a transaction that succeeded reads `NotFound`. Read a status while the transaction is
 * recent, and store the final one.
 *
 * @example
 * ```ts
 * import type { StellarAccountAddress } from "@effect-blockchain/stellar/StellarAddress"
 * import { StellarRelayer } from "@effect-blockchain/stellar/StellarRelayer"
 * import type { StellarSigner } from "@effect-blockchain/stellar/StellarSigner"
 * import type { StellarTransactionHash } from "@effect-blockchain/stellar/StellarTransactionHash"
 * import { Asset, Operation } from "@stellar/stellar-sdk"
 * import * as Effect from "effect/Effect"
 *
 * declare const signer: StellarSigner
 * declare const destination: StellarAccountAddress
 * declare const store: (hash: StellarTransactionHash, sequence: bigint, maxLedger: bigint) => Effect.Effect<void>
 *
 * const program = Effect.gen(function*() {
 *   const relayer = yield* StellarRelayer
 *   const payment = Operation.payment({ destination, asset: Asset.native(), amount: "1" })
 *   const { hash, maxLedger, sequence, signed } = yield* relayer.sign({ signer, operations: [payment.toXDR("base64")] })
 *   // stored before the broadcast: a crash in between leaves a hash to look up, never an unknown transaction
 *   yield* store(hash, sequence, maxLedger)
 *   yield* relayer.broadcast({ signed })
 *   // `maxLedger` ends the wait with `Expired` when no ledger took the transaction, the timeout bounds the rest
 *   const status = yield* relayer.awaitConfirmation({ hash, maxLedger }).pipe(Effect.timeout("10 minutes"))
 *   if (status._tag === "Failed") {
 *     yield* Effect.logError(`failed in ledger ${status.block}: ${status.reason?.code}`)
 *   }
 * })
 * ```
 *
 * @since 0.2.0
 */
import { Account, FeeBumpTransaction, Keypair, TransactionBuilder, xdr } from "@stellar/stellar-sdk"
import type * as Arr from "effect/Array"
import * as BigInt_ from "effect/BigInt"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as Confirmations from "./internal/confirmations.ts"
import { DEFAULT_POLL_INTERVAL } from "./StellarIndexer.ts"
import * as StellarNetwork from "./StellarNetwork.ts"
import * as StellarRpc from "./StellarRpc.ts"
import { type StellarSigner, StellarSignerError } from "./StellarSigner.ts"
import { StellarTransactionHash } from "./StellarTransactionHash.ts"

/**
 * Why a transaction failed, from its result XDR: its result code and, when that is `txFailed`, the result code of each
 * operation in order, the ones that succeeded included. For a fee bump whose inner transaction failed
 * (`txFeeBumpInnerFailed`), both are those of the inner transaction.
 *
 * @since 0.2.0
 * @category models
 */
export interface StellarTransactionFailure {
  readonly code: StellarTransactionResultCode
  readonly operations: ReadonlyArray<StellarOperationResultCode>
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
 * A transaction signed by {@link StellarRelayer.sign}: `signed` is the base64 `TransactionEnvelope` XDR `broadcast`
 * takes, `hash` its transaction hash, `sequence` the sequence number it uses and `maxLedger` the last ledger that can
 * hold it, which `fetchTransactionStatus` and `awaitConfirmation` take.
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
 * @since 0.2.0
 * @category services
 */
export class StellarRelayer extends Context.Service<StellarRelayer, {
  /**
   * Signs a transaction of `operations` (each a base64 `Operation` XDR, at most 100) from the account
   * `signer.address` without sending it. A missing `sequence` is the account's sequence number plus 1, a missing `fee`
   * (stroops per operation) comes from the layer's fee strategy, and a missing `maxLedger` is the latest ledger plus
   * the layer's `validity`.
   *
   * A single `invokeHostFunction` operation is simulated: the transaction gets its footprint and resources, the
   * operation the authorization entries it has none of, and the resource fee is added to `fee`, then taken from the
   * Soroban inclusion fees. Fails with a {@link StellarSimulationError} when the simulation does.
   *
   * Fails with a `StellarSignerError` when an operation is not XDR, or when the account does not exist and no
   * `sequence` is given.
   */
  readonly sign: (options: {
    readonly signer: StellarSigner
    readonly operations: Arr.NonEmptyReadonlyArray<string>
    readonly sequence?: bigint | undefined
    readonly fee?: bigint | undefined
    readonly maxLedger?: bigint | undefined
  }) => Effect.Effect<
    StellarSignedTransaction,
    StellarRpc.StellarRpcError | StellarSignerError | StellarSimulationError
  >
  /**
   * Wraps the signed transaction `signed` in a fee bump paid and signed by `signer`, without sending it, and returns
   * its envelope and its own hash, the one to follow. A missing `fee` (stroops per operation, the fee bump counting
   * as one) comes from the layer's fee strategy, and is at least the fee of `signed`, as the network requires.
   *
   * The fee bump shares the sequence number and `maxLedger` of `signed`. Fails with a `StellarSignerError` when
   * `signed` is not a transaction envelope, or `fee` is below its fee.
   */
  readonly feeBump: (options: {
    readonly signer: StellarSigner
    readonly signed: string
    readonly fee?: bigint | undefined
  }) => Effect.Effect<
    { readonly hash: StellarTransactionHash; readonly signed: string },
    StellarRpc.StellarRpcError | StellarSignerError
  >
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
  readonly fetchTransactionStatus: (options: {
    readonly hash: StellarTransactionHash
    readonly maxLedger?: bigint | undefined
  }) => Effect.Effect<StellarTransactionStatus, StellarRpc.StellarRpcError>
  /**
   * Reads {@link fetchTransactionStatus} on `poll` (`Schedule.spaced(StellarIndexer.DEFAULT_POLL_INTERVAL)` by
   * default) until it is `Confirmed`, `Failed` or `Expired`, and returns it. `NotFound` keeps polling, so pass
   * `maxLedger` or bound the wait with a timeout. A `poll` that ends first returns the last status read.
   */
  readonly awaitConfirmation: (options: {
    readonly hash: StellarTransactionHash
    readonly maxLedger?: bigint | undefined
    readonly poll?: Schedule.Schedule<unknown> | undefined
  }) => Effect.Effect<StellarTransactionStatus, StellarRpc.StellarRpcError>
}>()("@effect-blockchain/stellar/StellarRelayer") {}

const operationCode = (operation: xdr.OperationResult): StellarOperationResultCode => {
  const code = operation.switch().name
  return code === "opInner" ? operation.tr().value().switch().name : code
}

const failureOf = (resultXdr: string): StellarTransactionFailure | undefined => {
  try {
    const outer = xdr.TransactionResult.fromXDR(resultXdr, "base64").result()
    const result = outer.switch().name === "txFeeBumpInnerFailed" ? outer.innerResultPair().result().result() : outer
    const code = result.switch().name
    return { code, operations: code === "txFailed" ? result.results().map(operationCode) : [] }
  } catch {
    return undefined
  }
}

// the network's minimum base fee: https://developers.stellar.org/docs/learn/fundamentals/fees-resource-limits-metering
const MIN_FEE = BigInt(100)

/**
 * The library's fee strategy, in stroops per operation: the 90th percentile of the recent inclusion fees, at least
 * the network's minimum of 100.
 *
 * @since 0.2.0
 * @category fees
 */
export const defaultFees = (inclusionFee: StellarRpc.StellarFeeDistribution): bigint =>
  BigInt_.max(inclusionFee.p90, MIN_FEE)

const toSignerError = (cause: unknown) => new StellarSignerError({ cause })

const accountKey = (address: string) =>
  xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(address).xdrAccountId() }))
    .toXDR("base64")

/**
 * Builds a {@link StellarRelayer} over the provided {@link StellarRpc.StellarRpc}. `confirmations` overrides the
 * network's default (0), as in `StellarIndexer.layer`: both agree on the last confirmed ledger. `fees` (default
 * {@link defaultFees}) prices the transactions signed without an explicit fee from the inclusion fees of
 * `getFeeStats`, classic or Soroban, and `validity` (default 60, about 5 minutes) is the number of ledgers after the latest one that a
 * transaction signed without `maxLedger` can enter.
 *
 * @since 0.2.0
 * @category layers
 */
export const layer = (options: {
  readonly confirmations?: number | undefined
  readonly fees?: ((inclusionFee: StellarRpc.StellarFeeDistribution) => bigint) | undefined
  readonly validity?: number | undefined
} = {}): Layer.Layer<StellarRelayer, never, StellarRpc.StellarRpc> =>
  Layer.effect(
    StellarRelayer,
    Effect.gen(function*() {
      const rpc = yield* StellarRpc.StellarRpc
      const networkPassphrase = StellarNetwork.toPassphrase(rpc.network)
      // Soroban and classic transactions compete for separate ledger space, each with its own fees
      const estimateFee = (soroban: boolean) =>
        Effect.map(
          rpc.getFeeStats,
          (stats) => (options.fees ?? defaultFees)(soroban ? stats.sorobanInclusionFee : stats.inclusionFee)
        )
      const hashOf = (envelope: string) =>
        Effect.try({
          try: () =>
            StellarTransactionHash.make(
              `0x${TransactionBuilder.fromXDR(envelope, networkPassphrase).hash().toString("hex")}`
            ),
          catch: toSignerError
        })
      const sign = Effect.fn("StellarRelayer.sign")(
        function*({ operations, signer, ...given }: Parameters<StellarRelayer["Service"]["sign"]>[0]) {
          const parsed = yield* Effect.try({
            try: () => operations.map((operation) => xdr.Operation.fromXDR(operation, "base64")),
            catch: toSignerError
          })
          const [first] = parsed
          const invocation = parsed.length === 1 && first?.body().switch().name === "invokeHostFunction"
            ? first.body().invokeHostFunctionOp()
            : undefined
          const [{ entries: [account], latestLedger }, fee] = yield* Effect.all([
            rpc.getLedgerEntries({ keys: [accountKey(signer.address)] }),
            given.fee === undefined ? estimateFee(invocation !== undefined) : Effect.succeed(given.fee)
          ], { concurrency: "unbounded" })
          const maxLedger = given.maxLedger ?? latestLedger + BigInt(options.validity ?? 60)
          const sequence = given.sequence ?? (account === undefined
            ? yield* new StellarSignerError({ cause: new Error(`account ${signer.address} does not exist`) })
            : BigInt(xdr.LedgerEntryData.fromXDR(account.xdr, "base64").account().seqNum().toString()) + BigInt(1))
          const build = (fee: bigint, sorobanData?: string) =>
            Effect.try({
              try: () => {
                // the builder signs with the sequence number after the account's
                const source = new Account(signer.address, (sequence - BigInt(1)).toString())
                const builder = new TransactionBuilder(source, {
                  fee: fee.toString(),
                  networkPassphrase,
                  ledgerbounds: { minLedger: 0, maxLedger: Number(maxLedger) },
                  timebounds: { minTime: 0, maxTime: 0 },
                  ...(sorobanData === undefined ? {} : { sorobanData })
                })
                parsed.forEach((operation) => builder.addOperation(operation))
                return builder.build().toEnvelope().toXDR("base64")
              },
              catch: toSignerError
            })
          const prepare = Effect.fnUntraced(function*(invocation: xdr.InvokeHostFunctionOp) {
            const simulation = yield* rpc.simulateTransaction({ transaction: yield* build(fee) })
            if ("error" in simulation) {
              return yield* new StellarSimulationError({ reason: new SimulationFailed({ error: simulation.error }) })
            }
            // entries the caller built and signed are kept
            if (invocation.auth().length === 0) {
              const auth = (simulation.results?.[0]?.auth ?? []).map((entry) =>
                xdr.SorobanAuthorizationEntry.fromXDR(entry, "base64")
              )
              // any other credentials carry a signature of their own, which the transaction's does not replace
              if (auth.some((entry) => entry.credentials().switch().name !== "sorobanCredentialsSourceAccount")) {
                return yield* new StellarSimulationError({ reason: new UnsupportedAuth() })
              }
              invocation.auth(auth)
            }
            // the builder adds the resource fee `transactionData` holds, the simulation's `minResourceFee`
            return yield* build(fee, simulation.transactionData)
          })
          const envelope = yield* (invocation === undefined ? build(fee) : prepare(invocation))
          const signed = yield* signer.signTransaction({ network: rpc.network, envelope })
          return { hash: yield* hashOf(signed), signed, sequence, maxLedger }
        }
      )
      const feeBump = Effect.fn("StellarRelayer.feeBump")(
        function*({ signed, signer, ...given }: Parameters<StellarRelayer["Service"]["feeBump"]>[0]) {
          const inner = yield* Effect.try({
            try: () => {
              const transaction = TransactionBuilder.fromXDR(signed, networkPassphrase)
              if (transaction instanceof FeeBumpTransaction) throw new Error("already a fee bump")
              return transaction
            },
            catch: toSignerError
          })
          const sorobanData = inner.tx instanceof xdr.Transaction && inner.tx.ext().switch() === 1
            ? inner.tx.ext().sorobanData()
            : undefined
          const count = BigInt(inner.operations.length)
          const resourceFee = BigInt(sorobanData?.resourceFee().toString() ?? 0)
          // a fee bump must offer at least the inclusion fee per operation of its inner transaction (CAP-0015)
          const innerFee = (BigInt(inner.fee) - resourceFee + count - BigInt(1)) / count
          const fee = given.fee ?? BigInt_.max(innerFee, yield* estimateFee(sorobanData !== undefined))
          const envelope = yield* Effect.try({
            try: () =>
              TransactionBuilder.buildFeeBumpTransaction(signer.address, fee.toString(), inner, networkPassphrase)
                .toEnvelope().toXDR("base64"),
            catch: toSignerError
          })
          const bumped = yield* signer.signTransaction({ network: rpc.network, envelope })
          return { hash: yield* hashOf(bumped), signed: bumped }
        }
      )
      const broadcast = Effect.fn("StellarRelayer.broadcast")(
        function*({ signed }: { readonly signed: string }) {
          const sent = yield* rpc.sendTransaction({ transaction: signed })
          if (sent.status === "PENDING" || sent.status === "DUPLICATE") return sent.hash
          const failure = failureOf(sent.errorResultXdr ?? "")
          const reason = sent.status === "TRY_AGAIN_LATER"
            ? new TryAgainLater()
            : new Refused({ code: failure?.code, operations: failure?.operations ?? [] })
          // a node that has this transaction in a ledger refuses its second copy: stellar-core answers
          // `TRY_AGAIN_LATER` for about 10 ledgers after applying it, then that its sequence number is used
          if (
            (reason._tag === "TryAgainLater" || reason.code === "txBadSeq") &&
            (yield* rpc.getTransaction({ hash: sent.hash })).status !== "NOT_FOUND"
          ) return sent.hash
          return yield* new StellarBroadcastError({ reason })
        }
      )
      const fetchTransactionStatus = Effect.fn("StellarRelayer.fetchTransactionStatus")(
        ({ hash, maxLedger }: Parameters<StellarRelayer["Service"]["fetchTransactionStatus"]>[0]) =>
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
              block > Confirmations.lastConfirmedBlock(rpc.network, options.confirmations, transaction.latestLedger)
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
        awaitConfirmation: ({ poll = Schedule.spaced(DEFAULT_POLL_INTERVAL), ...transaction }) =>
          fetchTransactionStatus(transaction).pipe(
            Effect.repeat({
              schedule: poll,
              until: ({ _tag }) => _tag === "Confirmed" || _tag === "Failed" || _tag === "Expired"
            }),
            Effect.withSpan("StellarRelayer.awaitConfirmation")
          )
      })
    })
  )

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

/**
 * The node did not take the transaction and asks to send it again later: it already holds a transaction of this
 * account, or its queue is full.
 *
 * @since 0.2.0
 * @category reasons
 */
export class TryAgainLater extends Schema.TaggedError<TryAgainLater>()("TryAgainLater", {}) {}

/**
 * The node refused the transaction: `code` is its result code (`txBadSeq`, `txInsufficientFee`,
 * `txInsufficientBalance`, `txTooLate`...), `undefined` when the result XDR cannot be decoded, and `operations` the
 * result code of each operation when the code is `txFailed`.
 *
 * @since 0.2.0
 * @category reasons
 */
export class Refused extends Schema.TaggedError<Refused>()("Refused", {
  code: Schema.UndefinedOr(StellarTransactionResultCode),
  operations: Schema.Array(StellarOperationResultCode)
}) {}

/**
 * Why a node did not accept a transaction, the `reason` of a {@link StellarBroadcastError}, matched with
 * `Effect.catchReason`.
 *
 * @since 0.2.0
 * @category reasons
 */
export const StellarBroadcastReason = Schema.Union([TryAgainLater, Refused])

/**
 * @since 0.2.0
 * @category reasons
 */
export type StellarBroadcastReason = typeof StellarBroadcastReason.Type

/**
 * A node did not accept the transaction, for the `reason` it gave. A failed request stays a `StellarRpcError`.
 *
 * @since 0.2.0
 * @category errors
 */
export class StellarBroadcastError extends Schema.TaggedError<StellarBroadcastError>()("StellarBroadcastError", {
  reason: StellarBroadcastReason
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
 * The invocation needs an authorization entry signed by an address, which the signature of the transaction does not
 * give: pass the operation with its signed entries.
 *
 * @since 0.2.0
 * @category reasons
 */
export class UnsupportedAuth extends Schema.TaggedError<UnsupportedAuth>()("UnsupportedAuth", {}) {}

/**
 * A Soroban invocation could not be prepared for signing, for a `reason` matched with `Effect.catchReason`.
 *
 * @since 0.2.0
 * @category errors
 */
export class StellarSimulationError extends Schema.TaggedError<StellarSimulationError>()("StellarSimulationError", {
  reason: Schema.Union([SimulationFailed, UnsupportedAuth])
}) {}
