// Replays real Quasar replies (recorded by `scripts/record-fixtures.ts`) through the real `StellarRpc` layer.
import * as Replay from "@effect-blockchain/core/test/utils/replay"
import { StellarAccountAddress, StellarContractAddress } from "@effect-blockchain/stellar/StellarAddress"
import { toPassphrase } from "@effect-blockchain/stellar/StellarNetwork"
import { defaultFees } from "@effect-blockchain/stellar/StellarRelayer"
import * as StellarRpc from "@effect-blockchain/stellar/StellarRpc"
import { StellarTransactionHash } from "@effect-blockchain/stellar/StellarTransactionHash"
import { assert, describe, expect, it } from "@effect/vitest"
import { Account, Networks, Operation, TransactionBuilder, xdr } from "@stellar/stellar-sdk"
import * as Arr from "effect/Array"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import { accountEntry } from "../src/internal/accountChange.ts"
import { accountKey } from "./utils/ledgerMeta.ts"

const network = ["getNetwork", "getHealth"]

const EUTBL = StellarContractAddress.make("CBGV2QFQBBGEQRUKUMCPO3SZOHDDYO6SCP5CH6TW7EALKVHCXTMWDDOF")
const USTBL = StellarContractAddress.make("CARUUX2FZNPH6DGJOEUFSIUQWYHNL5AVDV7PMVSHWL7OBYIBFC76F4TO")
const BINANCE = StellarAccountAddress.make("GABFQIK63R2NETJM7T673EAMZN4RJLLGP3OFUEJU5SZVTGWUKULZJNL6")
const MISSING = StellarAccountAddress.make("GD7777777777777777777777777777777777777777777777777773DB")
const key = (address: string) => accountKey(address).toXdr("base64")
// pruned on the regular endpoint, served by the archive one
const V1_LEDGER = BigInt(55000004)
// the pinned range, as recorded: `endLedger` is `toBlock + 1`
const FROM = BigInt(65270680)
const TO = BigInt(65271880)

const setup = (endpoints: Arr.NonEmptyReadonlyArray<Replay.Endpoint>) => {
  const { check, endpoints: urls, fetch } = Replay.replay(new URL("fixtures/", import.meta.url), endpoints)
  const layer = StellarRpc.layer({ network: "Stellar", endpoints: urls, retries: 0 }).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))
  )
  return <A, E>(f: (rpc: StellarRpc.StellarRpc["Service"]) => Effect.Effect<A, E>) =>
    check(
      Effect.gen(function*() {
        return yield* f(yield* StellarRpc.StellarRpc)
      }).pipe(Effect.provide(layer))
    )
}

const ledgersCursor = (endpoint: string, cursor: string) => StellarRpc.StellarLedgersCursor.make({ endpoint, cursor })

// a regular endpoint with no fixture, then the archive one: an archive call must skip the first
const archive = (cases: ReadonlyArray<string>) => {
  const { check, endpoints, fetch, served } = Replay.replay(new URL("fixtures/", import.meta.url), [
    { name: "quasar", cases: [] },
    { name: "quasar-archive", cases: ["getNetwork", ...cases] }
  ])
  const layer = StellarRpc.layer({
    network: "Stellar",
    endpoints: Arr.map(endpoints, (endpoint) => ({ ...endpoint, archive: endpoint.name === "quasar-archive" })),
    retries: 0
  }).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)))
  const run = <A, E>(f: (rpc: StellarRpc.StellarRpc["Service"]) => Effect.Effect<A, E>) =>
    check(
      Effect.gen(function*() {
        return yield* f(yield* StellarRpc.StellarRpc)
      }).pipe(Effect.provide(layer))
    )
  return { run, served }
}

const quasarCursor = (cursor: string) => StellarRpc.StellarEventsCursor.make({ endpoint: "quasar", cursor })

const simulation = (name: string) => ({
  transaction: new TransactionBuilder(new Account(BINANCE, "0"), { fee: "100", networkPassphrase: Networks.PUBLIC })
    .addOperation(Operation.invokeContractFunction({ contract: EUTBL, function: name, args: [] }))
    .setTimeout(0)
    .build()
    .toEnvelope()
    .toXdr("base64")
})

const eutbl = { contractIds: [EUTBL], fromBlock: FROM, toBlock: TO, limit: 3 } as const

describe("StellarRpc fixtures", () => {
  it.effect("fixture: quasar getNetwork", () =>
    Effect.gen(function*() {
      const info = yield* setup([{ name: "quasar", cases: network }])((rpc) => rpc.getNetwork)
      assert.deepStrictEqual(info, { passphrase: toPassphrase("Stellar"), protocolVersion: 29 })
    }))

  it.effect("fixture: quasar getEvents EUTBL and its next page", () =>
    Effect.gen(function*() {
      const run = setup([{ name: "quasar", cases: [...network, "getEvents-eutbl-page-1", "getEvents-eutbl-page-2"] }])
      const [first, next] = yield* run((rpc) =>
        Effect.flatMap(
          rpc.getEvents(eutbl),
          (first) => Effect.map(rpc.getEvents({ ...eutbl, cursor: first.cursor }), (next) => [first, next] as const)
        )
      )
      assert.deepStrictEqual(first.events.map((event) => event.id), [
        "0280335478937866240-0000000000",
        "0280335478937886720-0000000000",
        "0280335478937985024-0000000000"
      ])
      const event = first.events[0]
      assert.strictEqual(event.contractId, EUTBL)
      assert.strictEqual(event.blockNumber, BigInt(65270690))
      assert.strictEqual(
        event.transactionHash,
        "0xcd624565b0c34653c21a2e2d7c08ed8e3bdeabe0684b08d89d96f96d7d9d1b6b"
      )
      assert.strictEqual(event.topics[0], "AAAADwAAAAh0cmFuc2Zlcg==") // Symbol("transfer")
      assert.strictEqual(event.value, "AAAACgAAAAAAAAAAAAAAAAAAA60=") // i128 941
      assert.deepStrictEqual(first.cursor, quasarCursor("0280335478937985024-0000000000"))
      assert.deepStrictEqual(next.events.map((event) => event.id), [
        "0280335478938116096-0000000000",
        "0280335478938181632-0000000000",
        "0280335478938210304-0000000000"
      ])
      assert.deepStrictEqual(next.cursor, quasarCursor("0280335478938210304-0000000000"))
    }))

  it.effect("fixture: quasar getEvents USTBL", () =>
    Effect.gen(function*() {
      const page = yield* setup([{ name: "quasar", cases: [...network, "getEvents-ustbl"] }])((rpc) =>
        rpc.getEvents({ ...eutbl, contractIds: [USTBL] })
      )
      assert.deepStrictEqual(page.events.map((event) => [event.contractId, event.blockNumber]), [
        [USTBL, BigInt(65270689)],
        [USTBL, BigInt(65271613)],
        [USTBL, BigInt(65271614)]
      ])
      assert.deepStrictEqual(page.cursor, quasarCursor("0280339447488344064-0000000000"))
    }))

  it.effect("fixture: quasar getEvents pruned", () =>
    Effect.gen(function*() {
      // the first page raises the known head, so the getHealth guard is skipped and the RPC's own error is mapped
      const error = yield* setup([{
        name: "quasar",
        cases: [...network, "getEvents-eutbl-page-1", "getEvents-pruned"]
      }])((
        rpc
      ) =>
        rpc.getEvents(eutbl).pipe(
          Effect.andThen(rpc.getEvents({ ...eutbl, fromBlock: BigInt(60000000), toBlock: BigInt(60000010) })),
          Effect.flip
        )
      )
      assert.strictEqual(error.reason._tag, "Pruned")
      assert.strictEqual(error.code, -32600)
    }))

  it.effect("fixture: quasar getEvents lagging", () =>
    Effect.gen(function*() {
      // answered by the getHealth guard: the library never sends a start ledger above the endpoint's latest ledger,
      // so the recorded `getEvents-lagging.json` reply (the same -32600 range error as pruned) is never replayed
      const error = yield* setup([{ name: "quasar", cases: network }])((rpc) =>
        Effect.flip(rpc.getEvents({ ...eutbl, fromBlock: BigInt(999999990), toBlock: BigInt(1000000000) }))
      )
      assert.strictEqual(error.reason._tag, "Lagging")
      assert.strictEqual(error.code, undefined)
    }))

  it.effect("fixture: quasar getEvents invalid params", () =>
    Effect.gen(function*() {
      const error = yield* setup([{ name: "quasar", cases: [...network, "invalid-params"] }])((rpc) =>
        Effect.flip(rpc.getEvents({ ...eutbl, limit: 20000 }))
      )
      assert.strictEqual(error.reason._tag, "Rejected")
      assert.strictEqual(error.code, -32602)
    }))

  it.effect("fixture: quasar getLedgerEntries of Binance and of a missing account", () =>
    Effect.gen(function*() {
      const [binance, missing] = yield* setup([{
        name: "quasar",
        cases: ["getNetwork", "getLedgerEntries-binance", "getLedgerEntries-missing"]
      }])((rpc) =>
        Effect.all([rpc.getLedgerEntries({ keys: [key(BINANCE)] }), rpc.getLedgerEntries({ keys: [key(MISSING)] })])
      )
      assert.strictEqual(
        accountEntry(binance.entries[0].xdr).balance,
        BigInt("378110440136408")
      )
      assert.strictEqual(binance.entries[0].lastModifiedLedger, BigInt(65338911))
      assert.strictEqual(binance.latestLedger, BigInt(65338914))
      assert.deepStrictEqual(missing, { entries: [], latestLedger: BigInt(65338914) })
    }))

  it.effect("fixture: quasar getLedgerEntries fails Lagging below minLedger", () =>
    Effect.gen(function*() {
      const error = yield* setup([{ name: "quasar", cases: ["getNetwork", "getLedgerEntries-binance"] }])((rpc) =>
        Effect.flip(rpc.getLedgerEntries({ keys: [key(BINANCE)], minLedger: BigInt(65338915) }))
      )
      expect(error).toMatchObject({ reason: { _tag: "Lagging", head: BigInt(65338914), toBlock: BigInt(65338915) } })
    }))

  it.effect("fixture: quasar getLedgers", () =>
    Effect.gen(function*() {
      const page = yield* setup([{ name: "quasar", cases: ["getNetwork", "getLedgers-binance"] }])((rpc) =>
        rpc.getLedgers({ startLedger: BigInt(65338911), limit: 1 })
      )
      assert.deepStrictEqual(page.ledgers.map(({ closeTime, sequence }) => [sequence, closeTime]), [
        [BigInt(65338911), 1793980597]
      ])
      assert.lengthOf(page.ledgers[0].metadataXdr, 952376)
      expect(page).toMatchObject({
        cursor: { endpoint: "quasar", cursor: "65338911" },
        latestLedger: BigInt(65338914),
        oldestLedger: BigInt(65217955)
      })
    }))

  it.effect("fixture: quasar getLedgers falls back from pruned to quasar-archive", () =>
    Effect.gen(function*() {
      const { check, endpoints, fetch, served } = Replay.replay(new URL("fixtures/", import.meta.url), [
        { name: "quasar", cases: ["getNetwork", "getLedgers-pruned"] },
        { name: "quasar-archive", cases: ["getNetwork", "getLedgers-v1"] }
      ])
      const { ledgers } = yield* check(
        Effect.gen(function*() {
          return yield* (yield* StellarRpc.StellarRpc).getLedgers({ startLedger: V1_LEDGER, limit: 1 })
        }).pipe(
          Effect.provide(
            StellarRpc.layer({ network: "Stellar", endpoints, retries: 0 }).pipe(
              Layer.provide(FetchHttpClient.layer),
              Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))
            )
          )
        )
      )
      assert.deepStrictEqual(ledgers.map(({ closeTime, sequence }) => [sequence, closeTime]), [
        [V1_LEDGER, 1735223597]
      ])
      assert.deepStrictEqual(served, [
        "quasar getNetwork",
        "quasar getLedgers-pruned",
        "quasar-archive getNetwork",
        "quasar-archive getLedgers-v1"
      ])
    }))

  it.effect("fixture: quasar getLedgers lagging", () =>
    Effect.gen(function*() {
      const error = yield* setup([{ name: "quasar", cases: ["getNetwork", "getLedgers-lagging"] }])((rpc) =>
        Effect.flip(rpc.getLedgers({ startLedger: BigInt(999999990), limit: 1 }))
      )
      expect(error).toMatchObject({
        reason: { _tag: "Lagging", head: BigInt(65338915), toBlock: BigInt(999999990) },
        code: -32600
      })
    }))

  it.effect("fixture: quasar getLedgers cursor pruned, quasar-archive cursor lagging", () =>
    Effect.gen(function*() {
      const errors = yield* setup([
        { name: "quasar", cases: ["getNetwork", "getLedgers-cursor-pruned"] },
        { name: "quasar-archive", cases: ["getNetwork", "getLedgers-cursor-lagging"] }
      ])((rpc) =>
        Effect.all([
          Effect.flip(rpc.getLedgers({ cursor: ledgersCursor("quasar", "55000004"), limit: 1 })),
          Effect.flip(rpc.getLedgers({ cursor: ledgersCursor("quasar-archive", "999999990"), limit: 1 }))
        ])
      )
      expect(errors).toMatchObject([
        { reason: { _tag: "Pruned" }, code: -32602, endpoint: "quasar" },
        { reason: { _tag: "Lagging", head: BigInt(65528603), toBlock: BigInt(999999991) }, endpoint: "quasar-archive" }
      ])
    }))

  it.effect("fixture: quasar-archive getLedgers pages by cursor, skipping the regular endpoint", () =>
    Effect.gen(function*() {
      const { run, served } = archive(["getLedgers-v0-page", "getLedgers-v0-page-next"])
      const [first, next] = yield* run((rpc) =>
        Effect.flatMap(
          rpc.getLedgers({ startLedger: BigInt(30000003), limit: 2, archive: true }),
          (first) => Effect.map(rpc.getLedgers({ cursor: first.cursor, limit: 2 }), (next) => [first, next] as const)
        )
      )
      assert.deepStrictEqual(first.ledgers.map(({ closeTime, sequence }) => [sequence, closeTime]), [
        [BigInt(30000003), 1591454448],
        [BigInt(30000004), 1591454453]
      ])
      assert.deepStrictEqual(first.cursor, ledgersCursor("quasar-archive", "30000004"))
      assert.deepStrictEqual(next.ledgers.map(({ sequence }) => sequence), [BigInt(30000005), BigInt(30000006)])
      assert.deepStrictEqual(next.cursor, ledgersCursor("quasar-archive", "30000006"))
      // the archive endpoint retains far less than it serves
      assert.strictEqual(next.oldestLedger, BigInt(65528540))
      assert.deepStrictEqual(served, [
        "quasar-archive getNetwork",
        "quasar-archive getLedgers-v0-page",
        "quasar-archive getLedgers-v0-page-next"
      ])
    }))

  // ledgers with contract events of Soroban transactions, before and after protocol 23
  it.effect("fixture: quasar-archive getLedgers of a protocol 22 and a protocol 23 ledger", () =>
    Effect.gen(function*() {
      const { run } = archive(["getLedgers-v1-soroban", "getLedgers-v2-soroban"])
      const pages = yield* run((rpc) =>
        Effect.forEach(
          [58000008, 59000000],
          (ledger) => rpc.getLedgers({ startLedger: BigInt(ledger), limit: 1, archive: true })
        )
      )
      const metas = pages.map(({ ledgers }) => xdr.LedgerCloseMeta.fromXdr(ledgers[0].metadataXdr, "base64"))
      assert.deepStrictEqual(pages.map(({ ledgers }) => [ledgers[0].sequence, ledgers[0].closeTime]), [
        [BigInt(58000008), 1752508309],
        [BigInt(59000000), 1758285731]
      ])
      assert.deepStrictEqual(metas.map((meta) => meta.type), ["v1", "v2"])
      assert.deepStrictEqual(metas.map((meta) => meta.value.ledgerHeader.header.ledgerVersion), [22, 23])
    }))

  it.effect("fixture: quasar getTransaction of a successful, a failed and an unknown transaction", () =>
    Effect.gen(function*() {
      const hashes = [
        "8ed811d0439b12fd5f4a2ebd043138079c46a82c9d51544fecb5379bbaf48505",
        "b1301e5ba2c2b35c9485cd8369f4c258d65666cf270cc3f2f9c03b72dded2059",
        "ab".repeat(32)
      ].map((hex) => StellarTransactionHash.make(`0x${hex}`))
      const [success, failed, unknown] = yield* setup([{
        name: "quasar",
        cases: ["getNetwork", "getTransaction-success", "getTransaction-failed", "getTransaction-not-found"]
      }])((rpc) => Effect.forEach(hashes, (hash) => rpc.getTransaction({ hash })))
      const range = { latestLedger: BigInt(65509517), oldestLedger: BigInt(65388558) }
      expect(success).toMatchObject({
        status: "SUCCESS",
        ...range,
        ledger: BigInt(65509458),
        createdAt: 1794833332,
        applicationOrder: 79,
        feeBump: false,
        resultXdr: "AAAAAAAAAGQAAAAAAAAAAQAAAAAAAAABAAAAAAAAAAA="
      })
      assert(success.status === "SUCCESS")
      assert.lengthOf(success.envelopeXdr, 316)
      assert.lengthOf(success.resultMetaXdr, 888)
      expect(failed).toMatchObject({ status: "FAILED", ...range, ledger: BigInt(65509460), applicationOrder: 1 })
      assert.deepStrictEqual(unknown, { status: "NOT_FOUND", ...range })
    }))

  it.effect("fixture: quasar getFeeStats", () =>
    Effect.gen(function*() {
      const stats = yield* setup([{ name: "quasar", cases: ["getNetwork", "getFeeStats"] }])((rpc) => rpc.getFeeStats)
      expect(stats.inclusionFee).toStrictEqual({
        max: BigInt(400),
        min: BigInt(100),
        mode: BigInt(100),
        p10: BigInt(100),
        p20: BigInt(100),
        p30: BigInt(100),
        p40: BigInt(100),
        p50: BigInt(100),
        p60: BigInt(100),
        p70: BigInt(100),
        p80: BigInt(100),
        p90: BigInt(200),
        p95: BigInt(200),
        p99: BigInt(300),
        transactionCount: 5022,
        ledgerCount: 10
      })
      expect(stats.sorobanInclusionFee).toMatchObject({ max: BigInt(114406), p99: BigInt(57203), ledgerCount: 50 })
      expect(stats.latestLedger).toBe(BigInt(65511132))
      expect(defaultFees(stats.inclusionFee)).toStrictEqual({ fee: BigInt(200) })
    }))

  // the unsigned calls of `scripts/record-fixtures.ts`
  it.effect("fixture: quasar simulateTransaction of a call that runs and of one that fails", () =>
    Effect.gen(function*() {
      const [decimals, missing] = yield* setup([{
        name: "quasar",
        cases: ["getNetwork", "simulateTransaction-decimals", "simulateTransaction-error"]
      }])((rpc) =>
        Effect.all([rpc.simulateTransaction(simulation("decimals")), rpc.simulateTransaction(simulation("missing"))])
      )
      assert(!("error" in decimals))
      assert.strictEqual(decimals.minResourceFee, BigInt(6343))
      assert.strictEqual(decimals.latestLedger, BigInt(65511453))
      // U32(5), with no authorization entry
      assert.deepStrictEqual(decimals.results, [{ auth: [], xdr: "AAAAAwAAAAU=" }])
      assert.strictEqual(
        xdr.SorobanTransactionData.fromXdr(decimals.transactionData, "base64").resourceFee,
        BigInt(6343)
      )
      assert("error" in missing)
      assert.match(missing.error, /^HostError: Error\(WasmVm, MissingValue\)/u)
    }))

  it.effect("fixture: quasar invalid key", () =>
    Effect.gen(function*() {
      const error = yield* setup([{ name: "quasar", cases: ["invalid-key"] }])((rpc) => Effect.flip(rpc.getNetwork))
      assert.strictEqual(error.reason._tag, "Unavailable")
      assert.strictEqual(error.code, 401)
    }))

  it.effect("fixture: quasar falls back from an invalid key", () =>
    Effect.gen(function*() {
      const page = yield* setup([
        { name: "quasar-invalid-key", provider: "quasar", cases: ["invalid-key"] },
        { name: "quasar", cases: [...network, "getEvents-ustbl"] }
      ])((rpc) => rpc.getEvents({ ...eutbl, contractIds: [USTBL] }))
      assert.strictEqual(page.events.length, 3)
      assert.strictEqual(page.cursor?.endpoint, "quasar")
    }))
})
