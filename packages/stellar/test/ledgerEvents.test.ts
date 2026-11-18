import { StellarContractAddress } from "@effect-blockchain/stellar/StellarAddress"
import type { StellarContractEvent } from "@effect-blockchain/stellar/StellarContractEvent"
import { assert, describe, it } from "@effect/vitest"
import { StrKey, xdr } from "@stellar/stellar-sdk"
import * as Arr from "effect/Array"
import * as Order from "effect/Order"
import { ledgerEvents, matchesTopics } from "../src/internal/ledgerEvents.ts"
import { ledgerMeta, recordedLedger, transaction } from "./utils/ledgerMeta.ts"

const contract = (byte: number) => StellarContractAddress.make(StrKey.encodeContract(Buffer.alloc(32, byte)))
const C = contract(7)
const D = contract(8)
const hash = (byte: number) => Buffer.alloc(32, byte)
const topic = (name: string) => xdr.ScVal.scvSymbol(name)
const point = xdr.ExtensionPoint.v0()

const event = (
  address: StellarContractAddress | null,
  name: string,
  type: xdr.ContractEventType = xdr.ContractEventType.contract
) =>
  new xdr.ContractEvent({
    ext: point,
    contractId: address === null ? null : new xdr.ContractId(StrKey.decodeContract(address)),
    type,
    body: xdr.ContractEventBody.v0(
      new xdr.ContractEventV0({ topics: [topic(name)], data: xdr.ScVal.scvU32(1) })
    )
  })

const v3 = (events: Array<xdr.ContractEvent> | null) =>
  xdr.TransactionMeta.v3(
    new xdr.TransactionMetaV3({
      ext: point,
      txChangesBefore: [],
      operations: [],
      txChangesAfter: [],
      sorobanMeta: events === null ? null : new xdr.SorobanTransactionMeta({
        ext: xdr.SorobanTransactionMetaExt.v0(),
        events,
        returnValue: xdr.ScVal.scvVoid(),
        diagnosticEvents: []
      })
    })
  )

const v4 = (
  operations: Array<Array<xdr.ContractEvent>>,
  events: Array<readonly [xdr.TransactionEventStage, xdr.ContractEvent]> = []
) =>
  xdr.TransactionMeta.v4(
    new xdr.TransactionMetaV4({
      ext: point,
      txChangesBefore: [],
      operations: operations.map((events) => new xdr.OperationMetaV2({ ext: point, changes: [], events })),
      txChangesAfter: [],
      sorobanMeta: null,
      events: events.map(([stage, event]) => new xdr.TransactionEvent({ stage, event })),
      diagnosticEvents: []
    })
  )

const LEDGER = BigInt(1000)
const ledger = (transactions: Array<xdr.TransactionResultMeta>) => ({
  sequence: LEDGER,
  closeTime: 1700000000,
  metadataXdr: ledgerMeta(transactions)
})

// the id of an event of ledger 1000, from the fields of its TOID
const id = (transaction: number, operation: number, index: number) =>
  `${String((LEDGER << BigInt(32)) + BigInt(transaction * 4096 + operation)).padStart(19, "0")}-${
    String(index).padStart(10, "0")
  }`

const summary = (events: ReadonlyArray<StellarContractEvent>) =>
  events.map((event) => [event.id, xdr.ScVal.fromXdr(event.topics[0], "base64").value?.toString()])

describe("ledgerEvents on recorded ledgers", () => {
  it("a protocol 22 ledger of the archive: fee, classic and Soroban events in id order", () => {
    const events = ledgerEvents(recordedLedger("quasar-archive", "getLedgers-v1-soroban"))
    assert.strictEqual(events.length, 469)
    assert.deepStrictEqual(events.map((event) => event.id), Arr.sort(events.map((event) => event.id), Order.String))
    assert.strictEqual(new Set(events.map((event) => event.id)).size, 469)
    assert.isTrue(
      events.every((event) =>
        event.blockNumber === BigInt(58000008) && event.ledgerClosedAt === "2025-07-14T15:51:49Z" &&
        event.type === "contract" && event.inSuccessfulContractCall
      )
    )
    // the fee of the first transaction, charged before all of them on the native asset contract
    assert.deepStrictEqual(
      { ...events[0], topics: events[0].topics.map((topic) => xdr.ScVal.fromXdr(topic, "base64").type) },
      {
        id: "0249108137527738368-0000000000",
        type: "contract",
        contractId: "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA",
        topics: ["scvSymbol", "scvAddress"],
        value: events[0].value,
        blockNumber: BigInt(58000008),
        ledgerClosedAt: "2025-07-14T15:51:49Z",
        transactionHash: events[0].transactionHash,
        inSuccessfulContractCall: true
      }
    )
    assert.match(events[0].transactionHash, /^0x[0-9a-f]{64}$/u)
  })

  it("keeps the events of the given contracts only, and skips a ledger without them undecoded", () => {
    const recorded = recordedLedger("quasar-archive", "getLedgers-v2-soroban")
    const all = ledgerEvents(recorded)
    const one = all[all.length - 1].contractId
    assert.deepStrictEqual(ledgerEvents(recorded, [one]), all.filter((event) => event.contractId === one))
    assert.deepStrictEqual(ledgerEvents({ ...recorded, metadataXdr: "not a meta" }, [C]), [])
    assert.throws(() => ledgerEvents({ ...recorded, metadataXdr: "not a meta" }))
  })
})

describe("ledgerEvents on built metas", () => {
  it("TransactionMeta v3: the Soroban events at operation 0 of each transaction, in application order", () => {
    const events = ledgerEvents(ledger([
      transaction([], v3([event(C, "a"), event(D, "b")]), { hash: hash(1) }),
      transaction([], v3(null), { hash: hash(2) }),
      transaction([], v3([event(C, "c")]), { hash: hash(3) })
    ]))
    assert.deepStrictEqual(events, [
      {
        id: id(1, 0, 0),
        type: "contract",
        contractId: C,
        topics: [topic("a").toXdr("base64")],
        value: xdr.ScVal.scvU32(1).toXdr("base64"),
        blockNumber: LEDGER,
        ledgerClosedAt: "2023-11-14T22:13:20Z",
        transactionHash: `0x${"01".repeat(32)}`,
        inSuccessfulContractCall: true
      },
      { ...events[1], id: id(1, 0, 1), contractId: D, transactionHash: `0x${"01".repeat(32)}` },
      { ...events[2], id: id(3, 0, 0), contractId: C, transactionHash: `0x${"03".repeat(32)}` }
    ])
  })

  it("skips failed transactions, system events and events without a contract, which still count in the index", () => {
    const events = ledgerEvents(ledger([
      transaction([], v3([event(C, "failed")]), { failed: true }),
      transaction([], v3([event(C, "system", xdr.ContractEventType.system), event(null, "none"), event(C, "kept")]))
    ]))
    assert.deepStrictEqual(summary(events), [[id(2, 0, 2), "kept"]])
  })

  it("TransactionMeta v4: operation events by operation, transaction events on the stage sentinels", () => {
    const before = xdr.TransactionEventStage.transactionEventStageBeforeAllTxs
    const after = xdr.TransactionEventStage.transactionEventStageAfterTx
    const afterAll = xdr.TransactionEventStage.transactionEventStageAfterAllTxs
    const events = ledgerEvents(ledger([
      transaction(
        [],
        v4([[event(C, "op0")], [], [event(C, "op2a"), event(C, "op2b")]], [
          [before, event(C, "fee1")],
          [after, event(C, "after1a")],
          [after, event(C, "after1b")],
          [afterAll, event(C, "refund1")]
        ])
      ),
      // a failed transaction: its fee event is dropped and takes an index before all transactions
      transaction([], v4([[event(C, "failed")]], [[before, event(C, "fee2")]]), { failed: true }),
      transaction(
        [],
        v4([[event(C, "op0")]], [
          [before, event(C, "fee3")],
          [after, event(C, "after3")],
          [afterAll, event(C, "refund3")]
        ])
      ),
      transaction(
        [],
        xdr.TransactionMeta.v2(
          new xdr.TransactionMetaV2({
            txChangesBefore: [],
            operations: [],
            txChangesAfter: []
          })
        )
      )
    ]))
    assert.deepStrictEqual(summary(events), [
      [id(0, 0, 0), "fee1"],
      [id(0, 0, 2), "fee3"],
      [id(1, 0, 0), "op0"],
      [id(1, 2, 0), "op2a"],
      [id(1, 2, 1), "op2b"],
      [id(1, 4095, 0), "after1a"],
      [id(1, 4095, 1), "after1b"],
      [id(3, 0, 0), "op0"],
      [id(3, 4095, 0), "after3"],
      [id(1048575, 0, 0), "refund1"],
      [id(1048575, 0, 1), "refund3"]
    ])
  })
})

describe("matchesTopics", () => {
  const cases: ReadonlyArray<readonly [ReadonlyArray<ReadonlyArray<string>> | undefined, Array<string>, boolean]> = [
    [undefined, ["a"], true],
    [[], ["a"], true],
    [[["a", "b"]], ["a", "b"], true],
    [[["a", "b"]], ["a", "c"], false],
    [[["a", "b"]], ["a", "b", "c"], false],
    [[["a"]], [], false],
    [[["*", "b"]], ["x", "b"], true],
    [[["*"]], [], false],
    [[["a", "**"]], ["a"], true],
    [[["a", "**"]], ["a", "b", "c"], true],
    [[["a", "**"]], ["b"], false],
    [[["a", "b", "**"]], ["a"], false],
    [[["x"], ["a"]], ["a"], true]
  ]
  it.each(cases)("%j on %j: %j", (filters, topics, expected) => {
    assert.strictEqual(matchesTopics(filters, topics), expected)
  })
})
