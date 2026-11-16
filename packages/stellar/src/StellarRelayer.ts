/**
 * Stellar transaction relaying on top of {@link StellarRpc.StellarRpc}: following a transaction until it is final.
 *
 * A relayer here sends an account's own transactions and manages their sequence numbers and fees, as OpenZeppelin
 * Relayer does. It is not a relayer paying for someone else's transaction. It keeps no state: storing hashes and
 * sequence numbers, deciding when to resend and holding keys belong to the application.
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
 * import { StellarRelayer } from "@effect-blockchain/stellar/StellarRelayer"
 * import type { StellarTransactionHash } from "@effect-blockchain/stellar/StellarTransactionHash"
 * import * as Effect from "effect/Effect"
 *
 * declare const hash: StellarTransactionHash
 * // the upper bound of the `ledgerBounds` the transaction was signed with
 * declare const maxLedger: bigint
 *
 * const program = Effect.gen(function*() {
 *   const relayer = yield* StellarRelayer
 *   const now = yield* relayer.fetchTransactionStatus({ hash, maxLedger })
 *   yield* Effect.log(`currently ${now._tag}`)
 *   // without `maxLedger`, a transaction that never reaches a ledger stays `NotFound`: the timeout bounds the wait
 *   const status = yield* relayer.awaitConfirmation({ hash, maxLedger }).pipe(Effect.timeout("2 minutes"))
 *   if (status._tag === "Failed") {
 *     yield* Effect.logError(`failed in ledger ${status.block}: ${status.reason?.code}`)
 *   }
 * })
 * ```
 *
 * @since 0.2.0
 */
import { xdr } from "@stellar/stellar-sdk"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as Confirmations from "./internal/confirmations.ts"
import { DEFAULT_POLL_INTERVAL } from "./StellarIndexer.ts"
import * as StellarRpc from "./StellarRpc.ts"
import type { StellarTransactionHash } from "./StellarTransactionHash.ts"

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
 * @since 0.2.0
 * @category services
 */
export class StellarRelayer extends Context.Service<StellarRelayer, {
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

/**
 * Builds a {@link StellarRelayer} over the provided {@link StellarRpc.StellarRpc}. `confirmations` overrides the
 * network's default (0), as in `StellarIndexer.layer`: both agree on the last confirmed ledger.
 *
 * @since 0.2.0
 * @category layers
 */
export const layer = (options: {
  readonly confirmations?: number | undefined
} = {}): Layer.Layer<StellarRelayer, never, StellarRpc.StellarRpc> =>
  Layer.effect(
    StellarRelayer,
    Effect.gen(function*() {
      const rpc = yield* StellarRpc.StellarRpc
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
