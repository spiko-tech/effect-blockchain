import { Address, StrKey, xdr } from "@stellar/stellar-sdk"
import * as Arr from "effect/Array"
import * as Order from "effect/Order"
import { StellarContractAddress } from "../StellarAddress.ts"
import type { StellarContractEvent } from "../StellarContractEvent.ts"
import type { StellarLedger } from "../StellarRpc.ts"
import { StellarTransactionHash } from "../StellarTransactionHash.ts"

// the widths of the transaction and operation fields of a TOID (`TransactionMask` and `OperationMask` in
// https://github.com/stellar/go-stellar-sdk/blob/main/toid/main.go)
const TRANSACTION_MASK = 0xfffff
const OPERATION_MASK = 0xfff

// `Cursor.String` in https://github.com/stellar/go-stellar-sdk/blob/main/protocols/rpc/get_events.go
const eventId = (ledger: bigint, transaction: number, operation: number, index: number) =>
  `${String((ledger << BigInt(32)) | BigInt(transaction * (OPERATION_MASK + 1) + operation)).padStart(19, "0")}-${
    String(index).padStart(10, "0")
  }`

const byId = Order.mapInput(Order.String, (event: StellarContractEvent) => event.id)

/**
 * The contract events of a `getLedgers` ledger, as `getEvents` returns them, in chain order (event id order). Events of
 * failed transactions and system events are left out. With `contractIds`, only the events of these contracts. Throws
 * on a malformed meta.
 *
 * Ids follow `InsertEvents` in
 * https://github.com/stellar/stellar-rpc/blob/main/cmd/stellar-rpc/internal/rpcv1/sqlitedb/event.go: the TOID of
 * (ledger, transaction application order from 1, operation index) and the index of the event in its operation, every
 * event counted. Transaction-level events (`TransactionMetaV4.events`, the fee events) take the sentinels of
 * `StageSentinels` in https://github.com/stellar/stellar-rpc/blob/main/cmd/stellar-rpc/internal/store/event.go, with
 * one index per ledger before and after all transactions, and one per transaction after it.
 *
 * @internal
 */
export const ledgerEvents = (
  ledger: StellarLedger,
  contractIds?: ReadonlyArray<StellarContractAddress>
): Array<StellarContractEvent> => {
  const bytes = Buffer.from(ledger.metadataXdr, "base64")
  // an event carries its contract id verbatim: most ledgers are skipped without decoding (1 to 3 MB)
  if (contractIds !== undefined && !contractIds.some((id) => bytes.includes(StrKey.decodeContract(id)))) return []
  const contracts = contractIds === undefined ? undefined : new Set<string>(contractIds)
  const meta = xdr.LedgerCloseMeta.fromXDR(bytes)
  const transactions: ReadonlyArray<xdr.TransactionResultMeta | xdr.TransactionResultMetaV1> = meta.switch() === 0
    ? meta.v0().txProcessing()
    : meta.switch() === 1
    ? meta.v1().txProcessing()
    : meta.v2().txProcessing()
  // RFC 3339 without fractional seconds, as stellar-rpc formats it
  const ledgerClosedAt = new Date(ledger.closeTime * 1000).toISOString().replace(".000Z", "Z")
  const events: Array<StellarContractEvent> = []
  // failed transactions advance these indexes too
  let beforeAll = 0
  let afterAll = 0
  transactions.forEach((transaction, position) => {
    const order = position + 1
    const result = transaction.result()
    const code = result.result().result().switch().name
    const successful = code === "txSuccess" || code === "txFeeBumpInnerSuccess"
    const transactionHash = StellarTransactionHash.make(`0x${result.transactionHash().toString("hex")}`)
    const add = (event: xdr.ContractEvent, toidTransaction: number, operation: number, index: number) => {
      const contract = event.contractId()
      // the SDK decodes an absent contract id to `undefined`, though it types it `null`
      if (!successful || event.type().name !== "contract" || contract === null || contract === undefined) return
      const contractId = StellarContractAddress.make(
        Address.fromScAddress(xdr.ScAddress.scAddressTypeContract(contract)).toString()
      )
      if (contracts !== undefined && !contracts.has(contractId)) return
      const body = event.body().v0()
      events.push({
        id: eventId(ledger.sequence, toidTransaction, operation, index),
        type: "contract",
        contractId,
        topics: body.topics().map((topic) => topic.toXDR("base64")),
        value: body.data().toXDR("base64"),
        blockNumber: ledger.sequence,
        ledgerClosedAt,
        transactionHash,
        inSuccessfulContractCall: true
      })
    }
    const apply = transaction.txApplyProcessing()
    if (apply.switch() === 3) {
      apply.v3().sorobanMeta()?.events().forEach((event, index) => add(event, order, 0, index))
    } else if (apply.switch() === 4) {
      let afterTransaction = 0
      for (const event of apply.v4().events()) {
        const stage = event.stage().name
        if (stage === "transactionEventStageBeforeAllTxes") add(event.event(), 0, 0, beforeAll++)
        else if (stage === "transactionEventStageAfterAllTxes") add(event.event(), TRANSACTION_MASK, 0, afterAll++)
        else add(event.event(), order, OPERATION_MASK, afterTransaction++)
      }
      apply.v4().operations().forEach((operation, operationIndex) =>
        operation.events().forEach((event, index) => add(event, order, operationIndex, index))
      )
    }
  })
  return Arr.sort(events, byId)
}

/**
 * Whether an event's `topics` match any of the `getEvents` topic `filters`, like `TopicFilter.Matches` in
 * https://github.com/stellar/go-stellar-sdk/blob/main/protocols/rpc/get_events.go. No filter matches every event.
 *
 * @internal
 */
export const matchesTopics = (
  filters: ReadonlyArray<ReadonlyArray<string>> | undefined,
  topics: ReadonlyArray<string>
): boolean =>
  filters === undefined || filters.length === 0 || filters.some((filter) => {
    const open = filter[filter.length - 1] === "**"
    const segments = open ? filter.slice(0, -1) : filter
    return (open ? topics.length >= segments.length : topics.length === segments.length) &&
      segments.every((segment, index) => segment === "*" || segment === topics[index])
  })
