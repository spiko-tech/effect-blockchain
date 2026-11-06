// Replays real Quasar replies (recorded by `scripts/record-fixtures.ts`) through the real `StellarRpc` layer.
import * as Replay from "@effect-blockchain/core/test/utils/replay"
import { StellarAccountAddress, StellarContractAddress } from "@effect-blockchain/stellar/StellarAddress"
import { toPassphrase } from "@effect-blockchain/stellar/StellarNetwork"
import * as StellarRpc from "@effect-blockchain/stellar/StellarRpc"
import { assert, describe, expect, it } from "@effect/vitest"
import type * as Arr from "effect/Array"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"

const network = ["getNetwork", "getHealth"]

const EUTBL = StellarContractAddress.make("CBGV2QFQBBGEQRUKUMCPO3SZOHDDYO6SCP5CH6TW7EALKVHCXTMWDDOF")
const USTBL = StellarContractAddress.make("CARUUX2FZNPH6DGJOEUFSIUQWYHNL5AVDV7PMVSHWL7OBYIBFC76F4TO")
const BINANCE = StellarAccountAddress.make("GABFQIK63R2NETJM7T673EAMZN4RJLLGP3OFUEJU5SZVTGWUKULZJNL6")
const MISSING = StellarAccountAddress.make("GD7777777777777777777777777777777777777777777777777773DB")
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

const quasarCursor = (cursor: string) => StellarRpc.StellarEventsCursor.make({ endpoint: "quasar", cursor })

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

  it.effect("fixture: quasar getAccount of Binance and of a missing account", () =>
    Effect.gen(function*() {
      const [binance, missing] = yield* setup([{
        name: "quasar",
        cases: ["getNetwork", "getLedgerEntries-binance", "getLedgerEntries-missing"]
      }])((rpc) => Effect.all([rpc.getAccount({ address: BINANCE }), rpc.getAccount({ address: MISSING })]))
      assert.deepStrictEqual(binance, {
        account: { balance: BigInt(378110440136408), lastModifiedLedger: BigInt(65338911) },
        latestLedger: BigInt(65338914)
      })
      assert.deepStrictEqual(missing, { account: undefined, latestLedger: BigInt(65338914) })
    }))

  it.effect("fixture: quasar getAccount fails Lagging below minBlock", () =>
    Effect.gen(function*() {
      const error = yield* setup([{ name: "quasar", cases: ["getNetwork", "getLedgerEntries-binance"] }])((rpc) =>
        Effect.flip(rpc.getAccount({ address: BINANCE, minBlock: BigInt(65338915) }))
      )
      expect(error).toMatchObject({ reason: { _tag: "Lagging", head: BigInt(65338914), toBlock: BigInt(65338915) } })
    }))

  it.effect("fixture: quasar getLedgers", () =>
    Effect.gen(function*() {
      const ledgers = yield* setup([{ name: "quasar", cases: ["getNetwork", "getLedgers-binance"] }])((rpc) =>
        rpc.getLedgers({ startLedger: BigInt(65338911), limit: 1 })
      )
      assert.deepStrictEqual(ledgers.map(({ closeTime, sequence }) => [sequence, closeTime]), [
        [BigInt(65338911), 1793980597]
      ])
      assert.lengthOf(ledgers[0].metadataXdr, 952376)
    }))

  it.effect("fixture: quasar getLedgers falls back from pruned to quasar-archive", () =>
    Effect.gen(function*() {
      const { check, endpoints, fetch, served } = Replay.replay(new URL("fixtures/", import.meta.url), [
        { name: "quasar", cases: ["getNetwork", "getLedgers-pruned"] },
        { name: "quasar-archive", cases: ["getNetwork", "getLedgers-v1"] }
      ])
      const ledgers = yield* check(
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
