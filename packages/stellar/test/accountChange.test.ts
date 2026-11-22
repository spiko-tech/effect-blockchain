import { StellarAccountAddress } from "@effect-blockchain/stellar/StellarAddress"
import { assert, describe, it } from "@effect/vitest"
import { StrKey, xdr } from "@stellar/stellar-sdk"
import * as Option from "effect/Option"
import { accountBefore, accountChange } from "../src/internal/accountChange.ts"
import {
  account,
  accountKey,
  dataEntry,
  dataKey,
  ledgerMeta,
  operation,
  recordedLedger,
  transaction,
  update
} from "./utils/ledgerMeta.ts"

const BINANCE = StellarAccountAddress.make("GABFQIK63R2NETJM7T673EAMZN4RJLLGP3OFUEJU5SZVTGWUKULZJNL6")
const A = StellarAccountAddress.make(StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 1)))
const B = StellarAccountAddress.make(StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 2)))

const change = (before: number, after: number) => Option.some({ before: BigInt(before), after: BigInt(after) })

// every expected value below is checked against an independent figure: the balance `getLedgerEntries` reported, or
// the `feeCharged` of the account's only transaction in the ledger
describe("accountChange on recorded ledgers", () => {
  const v2 = recordedLedger("quasar", "getLedgers-binance").metadataXdr
  const v1 = recordedLedger("quasar-archive", "getLedgers-v1").metadataXdr
  const v0 = recordedLedger("quasar-archive", "getLedgers-v0").metadataXdr

  it("LedgerCloseMeta v2 (protocol 29): ends at the balance getLedgerEntries reported for the ledger", () => {
    assert.deepStrictEqual(accountChange(v2, BINANCE), change(378110440126408, 378110440136408))
  })

  it("LedgerCloseMeta v2: applies the Soroban fee refund after the transaction", () => {
    // charged 17269 up front, refunded 5166: a net fee of 12103
    const source = StellarAccountAddress.make("GB5LCXFTBHXJ32XQBHX4EQKQPCHZRHU3XXHHN54QE3O3QTAN6RQZ3XEE")
    assert.deepStrictEqual(accountChange(v2, source), change(1168310068, 1168297965))
  })

  it("LedgerCloseMeta v1: charges the fee-bump fee source", () => {
    const feeSource = StellarAccountAddress.make("GBS7UCAACI45LNMRJ6HPS7JIPDI4RBC4CXIRPXEYT6U4V7QP6MKLO7RH")
    assert.deepStrictEqual(accountChange(v1, feeSource), change(1629500654602, 1629500654402))
  })

  it("LedgerCloseMeta v0: charges the source of a failed transaction", () => {
    const source = StellarAccountAddress.make("GCOGC4B2QKZC6FTBGF2JN5CNGPCBM6T7NBZ6PR4ENMCMNGOFLKCQEEJQ")
    assert.deepStrictEqual(accountChange(v0, source), change(2952345653, 2952345553))
  })

  it("is None for an account the ledger does not mention", () => {
    assert.deepStrictEqual(accountChange(v0, BINANCE), Option.none())
  })
})

describe("accountChange on synthetic ledgers", () => {
  const ops = (changes: Array<xdr.LedgerEntryChange>) => [new xdr.OperationMeta({ changes })]

  it("reads every TransactionMeta version", () => {
    const v1 = xdr.TransactionMeta.v1(
      new xdr.TransactionMetaV1({ txChanges: update(A, 1, 2), operations: ops(update(A, 2, 3)) })
    )
    const fields = {
      txChangesBefore: update(A, 3, 4),
      operations: ops(update(A, 4, 5)),
      txChangesAfter: update(A, 5, 6)
    }
    const v2 = xdr.TransactionMeta.v2(new xdr.TransactionMetaV2(fields))
    const ext = xdr.ExtensionPoint.v0()
    const v3 = xdr.TransactionMeta.v3(new xdr.TransactionMetaV3({ ...fields, ext, sorobanMeta: null }))
    assert.deepStrictEqual(accountChange(ledgerMeta([operation(update(A, 0, 1))]), A), change(0, 1))
    assert.deepStrictEqual(accountChange(ledgerMeta([transaction([], v1)]), A), change(1, 3))
    assert.deepStrictEqual(accountChange(ledgerMeta([transaction([], v2)]), A), change(3, 6))
    assert.deepStrictEqual(accountChange(ledgerMeta([transaction([], v3)]), A), change(3, 6))
  })

  it("charges every fee before applying any transaction", () => {
    const meta = ledgerMeta([operation(update(A, 80, 180), update(A, 100, 90)), operation([], update(A, 90, 80))])
    assert.deepStrictEqual(accountChange(meta, A), change(100, 180))
  })

  it("reads 0 before a created account and after a merged one", () => {
    const created = ledgerMeta([operation([xdr.LedgerEntryChange.ledgerEntryCreated(account(A, 50))])])
    const merged = ledgerMeta([
      operation([
        xdr.LedgerEntryChange.ledgerEntryState(account(A, 30)),
        xdr.LedgerEntryChange.ledgerEntryRemoved(accountKey(A))
      ])
    ])
    assert.deepStrictEqual(accountChange(created, A), change(0, 50))
    assert.deepStrictEqual(accountChange(merged, A), change(30, 0))
  })

  it("ignores other accounts and the account's other entries", () => {
    const meta = ledgerMeta([
      operation([
        ...update(B, 1, 2),
        xdr.LedgerEntryChange.ledgerEntryCreated(dataEntry(A)),
        xdr.LedgerEntryChange.ledgerEntryRemoved(dataKey(A))
      ])
    ])
    assert.deepStrictEqual(accountChange(meta, A), Option.none())
    assert.deepStrictEqual(accountChange(meta, B), change(1, 2))
  })

  it("throws on a malformed meta that mentions the account", () => {
    assert.throws(() => accountChange(Buffer.from(StrKey.decodeEd25519PublicKey(A)).toString("base64"), A))
  })
})

describe("accountBefore", () => {
  const before = (balance: number, lastModifiedLedger: number) =>
    Option.some({ created: false, balance: BigInt(balance), lastModifiedLedger: BigInt(lastModifiedLedger) })

  it("reads the state before the first change, the fee charge before the payment", () => {
    const meta = ledgerMeta([operation(update(A, 90, 50, 8), update(A, 100, 90, 7))])
    assert.deepStrictEqual(accountBefore(meta, A), before(100, 7))
  })

  it("reads a created account as created, and an account the ledger does not change as None", () => {
    const meta = ledgerMeta([operation([xdr.LedgerEntryChange.ledgerEntryCreated(account(A, 50))])])
    assert.deepStrictEqual(accountBefore(meta, A), Option.some({ created: true }))
    assert.deepStrictEqual(accountBefore(meta, B), Option.none())
  })

  it("finds an account whose only change is a Soroban fee refund", () => {
    // the recorded v2 ledger without its fee charges and transaction changes: only the refunds remain
    const source = StellarAccountAddress.make("GB5LCXFTBHXJ32XQBHX4EQKQPCHZRHU3XXHHN54QE3O3QTAN6RQZ3XEE")
    const recorded = xdr.LedgerCloseMeta.fromXdr(recordedLedger("quasar", "getLedgers-binance").metadataXdr, "base64")
    assert.strictEqual(recorded.type, "v2")
    if (recorded.type !== "v2") return
    const txProcessing = recorded.value.txProcessing.map((tx) =>
      new xdr.TransactionResultMetaV1({
        ...tx,
        feeProcessing: [],
        txApplyProcessing: xdr.TransactionMeta.operations([])
      })
    )
    const meta = xdr.LedgerCloseMeta.v2(new xdr.LedgerCloseMetaV2({ ...recorded.value, txProcessing })).toXdr("base64")
    // charged 17269 up front, so 1168310068 - 17269 before the refund
    const found = Option.map(accountBefore(meta, source), (state) => "balance" in state && state.balance)
    assert.deepStrictEqual(found, Option.some(BigInt(1168292799)))
  })

  it("throws when the account's first change is not its state or its creation", () => {
    const meta = ledgerMeta([operation([xdr.LedgerEntryChange.ledgerEntryUpdated(account(A, 5))])])
    assert.throws(() => accountBefore(meta, A), /expected the account's state first/)
  })
})
