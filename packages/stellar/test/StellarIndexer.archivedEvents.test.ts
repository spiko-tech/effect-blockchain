import * as JsonRpc from "@effect-blockchain/core/JsonRpc"
import * as Replay from "@effect-blockchain/core/test/utils/replay"
import { StellarContractAddress } from "@effect-blockchain/stellar/StellarAddress"
import * as StellarIndexer from "@effect-blockchain/stellar/StellarIndexer"
import * as StellarRpc from "@effect-blockchain/stellar/StellarRpc"
import { assert, describe, it } from "@effect/vitest"
import { StrKey, xdr } from "@stellar/stellar-sdk"
import * as Arr from "effect/Array"
import * as BigInt_ from "effect/BigInt"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as RpcMethods from "../src/internal/rpcMethods.ts"
import { ledgerMeta, transaction } from "./utils/ledgerMeta.ts"

const b = (n: number) => BigInt(n)
const fixtures = new URL("fixtures/", import.meta.url)

describe("StellarIndexer.fetchArchivedEvents", () => {
  it.effect("fixture: the events of two archive ledgers are the ones getEvents returns for them, ids included", () =>
    Effect.gen(function*() {
      // every contract event of ledgers 65528571 and 65528572, read from the regular endpoint with no contract filter
      const page = Schema.decodeUnknownSync(
        Schema.fromJsonString(Schema.Struct({ result: RpcMethods.getEvents.result }))
      )(Replay.load(fixtures, "quasar", "getEvents-all").body).result
      const expected = page.events.filter((event) => event.inSuccessfulContractCall)
      const contractIds = Arr.dedupe(expected.map((event) => event.contractId))
      assert.isTrue(Arr.isReadonlyArrayNonEmpty(contractIds))
      if (!Arr.isReadonlyArrayNonEmpty(contractIds)) return
      // the page is the whole range: below the limit, with failed transactions and both ledgers in it
      assert.strictEqual(page.events.length, 1467)
      assert.strictEqual(expected.length, 1083)
      assert.deepStrictEqual(Arr.dedupe(expected.map((event) => event.blockNumber)), [b(65528571), b(65528572)])

      const replay = Replay.replay(fixtures, [
        { name: "quasar", cases: [] },
        { name: "quasar-archive", cases: ["getNetwork", "getLedgers-recent"] }
      ])
      const layer = StellarIndexer.layer().pipe(
        Layer.provide(StellarRpc.layer({
          network: "Stellar",
          endpoints: Arr.map(replay.endpoints, (endpoint) => ({
            ...endpoint,
            archive: endpoint.name === "quasar-archive"
          })),
          retries: 0
        })),
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(Layer.succeed(FetchHttpClient.Fetch, replay.fetch))
      )
      const fetch = (filter: StellarIndexer.StellarIndexerArchivedEventsOptions["filter"]) =>
        Effect.gen(function*() {
          const indexer = yield* StellarIndexer.StellarIndexer
          return yield* indexer.fetchArchivedEvents({ filter, fromBlock: b(65528571), toBlock: b(65528572) })
        }).pipe(Effect.provide(layer), replay.check)

      const batch = yield* fetch({ contractIds })
      assert.deepStrictEqual(batch, { fromBlock: b(65528571), toBlock: b(65528572), events: expected })
      assert.deepStrictEqual(replay.served, ["quasar-archive getNetwork", "quasar-archive getLedgers-recent"])

      // a topic filter keeps what the same filter keeps of the `getEvents` events: the `transfer` events
      const transfer = xdr.ScVal.scvSymbol("transfer").toXdr("base64")
      const transfers = yield* fetch({ contractIds, topics: [[transfer, "**"]] })
      assert.deepStrictEqual(transfers.events, expected.filter((event) => event.topics[0] === transfer))
      assert.isAbove(transfers.events.length, 0)
      assert.isBelow(transfers.events.length, expected.length)
    }))
})

const C = StellarContractAddress.make(StrKey.encodeContract(Buffer.alloc(32, 7)))

// one event of `C` per ledger, in a `TransactionMeta` v3
const meta = ledgerMeta([
  transaction(
    [],
    xdr.TransactionMeta.v3(
      new xdr.TransactionMetaV3({
        ext: xdr.ExtensionPoint.v0(),
        txChangesBefore: [],
        operations: [],
        txChangesAfter: [],
        sorobanMeta: new xdr.SorobanTransactionMeta({
          ext: xdr.SorobanTransactionMetaExt.v0(),
          events: [
            new xdr.ContractEvent({
              ext: xdr.ExtensionPoint.v0(),
              contractId: new xdr.ContractId(StrKey.decodeContract(C)),
              type: xdr.ContractEventType.contract,
              body: xdr.ContractEventBody.v0(
                new xdr.ContractEventV0({ topics: [], data: xdr.ScVal.scvVoid() })
              )
            })
          ],
          returnValue: xdr.ScVal.scvVoid(),
          diagnosticEvents: []
        })
      })
    )
  )
])

// A fake archive serving at most `max` ledgers per page up to `head`. The n-th `getLedgers` call (1-based) fails with
// `failAt.get(n)` when set.
const fakeRpc = (head: bigint, max: number, failAt: ReadonlyMap<number, JsonRpc.Reason> = new Map()) => {
  const calls = new Array<readonly [bigint, number | undefined, boolean | undefined]>()
  const layer = Layer.mock(StellarRpc.StellarRpc)({
    network: "Stellar",
    getLedgers: (page) =>
      Effect.suspend(() => {
        if ("cursor" in page) return Effect.die("unused")
        const { archive, limit, startLedger } = page
        calls.push([startLedger, limit, archive])
        const reason = failAt.get(calls.length)
        if (reason !== undefined) {
          return Effect.fail(
            new StellarRpc.StellarRpcError({
              reason,
              method: "getLedgers",
              endpoint: "fake",
              cause: new Error(reason._tag)
            })
          )
        }
        const end = BigInt_.min(startLedger + b(Math.min(limit ?? max, max)) - b(1), head)
        return Effect.succeed({
          ledgers: Arr.makeBy(Number(end - startLedger) + 1, (i) => ({
            sequence: startLedger + b(i),
            closeTime: 1700000000,
            metadataXdr: meta
          })),
          cursor: StellarRpc.StellarLedgersCursor.make({ endpoint: "fake", cursor: String(end) }),
          latestLedger: head,
          oldestLedger: head
        })
      })
  })
  return { layer, calls }
}

const run = (
  rpc: Layer.Layer<StellarRpc.StellarRpc>,
  options: Omit<StellarIndexer.StellarIndexerArchivedEventsOptions, "filter">
) =>
  Effect.gen(function*() {
    const indexer = yield* StellarIndexer.StellarIndexer
    return yield* indexer.fetchArchivedEvents({ filter: { contractIds: [C] }, ...options })
  }).pipe(Effect.provide(StellarIndexer.layer({ confirmations: 0 }).pipe(Layer.provide(rpc))))

describe("StellarIndexer.fetchArchivedEvents paging", () => {
  it.effect("reads the range in pages of 10 ledgers from the archive endpoints, continuing a short page", () =>
    Effect.gen(function*() {
      const { calls, layer } = fakeRpc(b(1000), 7)
      const batch = yield* run(layer, { fromBlock: b(100), toBlock: b(124) })
      assert.deepStrictEqual(calls, [
        [b(100), 10, true],
        [b(107), 3, true],
        [b(110), 10, true],
        [b(117), 3, true],
        [b(120), 5, true]
      ])
      assert.deepStrictEqual([batch.fromBlock, batch.toBlock], [b(100), b(124)])
      assert.deepStrictEqual(
        batch.events.map((event) => event.blockNumber),
        Arr.makeBy(25, (i) => b(100 + i))
      )
    }))

  it.effect("reads pages concurrently and keeps the events in chain order", () =>
    Effect.gen(function*() {
      const { calls, layer } = fakeRpc(b(1000), 10)
      const batch = yield* run(layer, { fromBlock: b(100), toBlock: b(139), concurrency: 4 })
      assert.strictEqual(calls.length, 4)
      assert.deepStrictEqual(batch.events.map((event) => event.blockNumber), Arr.makeBy(40, (i) => b(100 + i)))
    }))

  it.effect("returns an empty batch without a request when fromBlock is above toBlock", () =>
    Effect.gen(function*() {
      const { calls, layer } = fakeRpc(b(1000), 10)
      const batch = yield* run(layer, { fromBlock: b(101), toBlock: b(100) })
      assert.deepStrictEqual(batch, { fromBlock: b(101), toBlock: b(100), events: [] })
      assert.deepStrictEqual(calls, [])
    }))

  it.effect("fails Lagging when the archive has not reached toBlock", () =>
    Effect.gen(function*() {
      const lagging = new JsonRpc.Lagging({ head: b(104), toBlock: b(105) })
      const { layer } = fakeRpc(b(104), 10, new Map([[2, lagging]]))
      const error = yield* Effect.flip(run(layer, { fromBlock: b(100), toBlock: b(109) }))
      assert.deepStrictEqual(error.reason, lagging)
    }))

  it.effect("retries a page failing with a transient reason, and no other", () =>
    Effect.gen(function*() {
      const flaky = fakeRpc(b(1000), 10, new Map([[1, new JsonRpc.Unavailable()]]))
      const batch = yield* run(flaky.layer, { fromBlock: b(100), toBlock: b(101), retry: Schedule.recurs(1) })
      assert.strictEqual(batch.events.length, 2)
      assert.strictEqual(flaky.calls.length, 2)

      const rejected = fakeRpc(b(1000), 10, new Map([[1, new JsonRpc.Rejected()]]))
      const error = yield* Effect.flip(
        run(rejected.layer, { fromBlock: b(100), toBlock: b(101), retry: Schedule.recurs(1) })
      )
      assert.strictEqual(error.reason._tag, "Rejected")
      assert.strictEqual(rejected.calls.length, 1)
    }))
})
