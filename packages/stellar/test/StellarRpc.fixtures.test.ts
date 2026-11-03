// Replays real Quasar replies (recorded by `scripts/record-fixtures.ts`) through the real `StellarRpc` layer.
import { StellarContractAddress } from "@effect-blockchain/stellar/StellarAddress"
import { toPassphrase } from "@effect-blockchain/stellar/StellarNetwork"
import * as StellarRpc from "@effect-blockchain/stellar/StellarRpc"
import { assert, describe, it } from "@effect/vitest"
import * as Arr from "effect/Array"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { readFileSync } from "node:fs"
import { isDeepStrictEqual } from "node:util"

const Fixture = Schema.Struct({
  provider: Schema.String,
  network: Schema.String,
  recordedAt: Schema.String,
  request: Schema.Struct({ method: Schema.String, params: Schema.optionalKey(Schema.Json) }),
  status: Schema.Number,
  body: Schema.String
})
type Fixture = typeof Fixture.Type

const load = (provider: string, name: string): Fixture =>
  Schema.decodeUnknownSync(Schema.fromJsonString(Fixture))(
    readFileSync(new URL(`fixtures/${provider}/${name}.json`, import.meta.url), "utf8")
  )

const quasar = (...names: Array<string>) => names.map((name) => load("quasar", name))
const network = quasar("getNetwork", "getHealth")

const EUTBL = StellarContractAddress.make("CBGV2QFQBBGEQRUKUMCPO3SZOHDDYO6SCP5CH6TW7EALKVHCXTMWDDOF")
const USTBL = StellarContractAddress.make("CARUUX2FZNPH6DGJOEUFSIUQWYHNL5AVDV7PMVSHWL7OBYIBFC76F4TO")
// the pinned range, as recorded: `endLedger` is `toBlock + 1`
const FROM = BigInt(65270680)
const TO = BigInt(65271880)

// one replay fetch serving every endpoint, routed by host `https://<name>.fixture`, answering the fixture whose request
// has the same method and params; an unmatched request fails the test
const setup = (endpoints: Record<string, ReadonlyArray<Fixture>>) => {
  const unmatched: Array<string> = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const name = new URL(String(input)).hostname.replace(/\.fixture$/u, "")
    const { method, params }: { method: string; params?: Schema.Json } = JSON.parse(String(init?.body))
    const fixture = endpoints[name]?.find((fixture) =>
      fixture.request.method === method && isDeepStrictEqual(fixture.request.params, params)
    )
    if (fixture !== undefined) return new Response(fixture.body, { status: fixture.status })
    unmatched.push(`${name} ${method} ${JSON.stringify(params)}`)
    return new Response("no fixture", { status: 404 })
  }
  const names = Object.keys(endpoints)
  if (!Arr.isReadonlyArrayNonEmpty(names)) throw new Error("setup needs at least one endpoint")
  const layer = StellarRpc.layer({
    network: "Stellar",
    endpoints: Arr.map(names, (name) => ({ name, url: Redacted.make(`https://${name}.fixture`) })),
    retries: 0
  }).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)))
  return <A, E>(f: (rpc: StellarRpc.StellarRpc["Service"]) => Effect.Effect<A, E>) =>
    Effect.gen(function*() {
      return yield* f(yield* StellarRpc.StellarRpc)
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(Effect.sync(() => assert.deepStrictEqual(unmatched, [], "unmatched requests")))
    )
}

const quasarCursor = (cursor: string) => StellarRpc.StellarEventsCursor.make({ endpoint: "quasar", cursor })

const eutbl = { contractIds: [EUTBL], fromBlock: FROM, toBlock: TO, limit: 3 } as const

describe("StellarRpc fixtures", () => {
  it.effect("fixture: quasar getNetwork", () =>
    Effect.gen(function*() {
      const info = yield* setup({ quasar: network })((rpc) => rpc.getNetwork)
      assert.deepStrictEqual(info, { passphrase: toPassphrase("Stellar"), protocolVersion: 29 })
    }))

  it.effect("fixture: quasar getEvents EUTBL and its next page", () =>
    Effect.gen(function*() {
      const run = setup({ quasar: [...network, ...quasar("getEvents-eutbl-page-1", "getEvents-eutbl-page-2")] })
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
      const page = yield* setup({ quasar: [...network, ...quasar("getEvents-ustbl")] })((rpc) =>
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
      const error = yield* setup({ quasar: [...network, ...quasar("getEvents-eutbl-page-1", "getEvents-pruned")] })((
        rpc
      ) =>
        rpc.getEvents(eutbl).pipe(
          Effect.andThen(rpc.getEvents({ ...eutbl, fromBlock: BigInt(60000000), toBlock: BigInt(60000010) })),
          Effect.flip
        )
      )
      assert.strictEqual(error.reason, "Pruned")
      assert.strictEqual(error.code, -32600)
    }))

  it.effect("fixture: quasar getEvents lagging", () =>
    Effect.gen(function*() {
      // answered by the getHealth guard: the library never sends a start ledger above the endpoint's latest ledger,
      // so the recorded `getEvents-lagging.json` reply (the same -32600 range error as pruned) is never replayed
      const error = yield* setup({ quasar: network })((rpc) =>
        Effect.flip(rpc.getEvents({ ...eutbl, fromBlock: BigInt(999999990), toBlock: BigInt(1000000000) }))
      )
      assert.strictEqual(error.reason, "Lagging")
      assert.strictEqual(error.code, undefined)
    }))

  it.effect("fixture: quasar getEvents invalid params", () =>
    Effect.gen(function*() {
      const error = yield* setup({ quasar: [...network, ...quasar("invalid-params")] })((rpc) =>
        Effect.flip(rpc.getEvents({ ...eutbl, limit: 20000 }))
      )
      assert.strictEqual(error.reason, "Rejected")
      assert.strictEqual(error.code, -32602)
    }))

  it.effect("fixture: quasar invalid key", () =>
    Effect.gen(function*() {
      const error = yield* setup({ quasar: quasar("invalid-key") })((rpc) => Effect.flip(rpc.getNetwork))
      assert.strictEqual(error.reason, "Unavailable")
      assert.strictEqual(error.code, 401)
    }))

  it.effect("fixture: quasar falls back from an invalid key", () =>
    Effect.gen(function*() {
      const page = yield* setup({
        "quasar-invalid-key": quasar("invalid-key"),
        quasar: [...network, ...quasar("getEvents-ustbl")]
      })((rpc) => rpc.getEvents({ ...eutbl, contractIds: [USTBL] }))
      assert.strictEqual(page.events.length, 3)
      assert.strictEqual(page.cursor?.endpoint, "quasar")
    }))
})
