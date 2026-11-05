import { StellarContractAddress } from "@effect-blockchain/stellar/StellarAddress"
import { StellarContractEvent } from "@effect-blockchain/stellar/StellarContractEvent"
import { toPassphrase } from "@effect-blockchain/stellar/StellarNetwork"
import * as StellarRpc from "@effect-blockchain/stellar/StellarRpc"
import { assert, describe, expect, it } from "@effect/vitest"
import { StrKey } from "@stellar/stellar-sdk"
import * as Arr from "effect/Array"
import * as Config from "effect/Config"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"

type Params = { readonly [key: string]: Schema.Json }
type Reply = { readonly result: Schema.Json } | { readonly error: { code: number; message: string } } | Response
type Node = Record<
  string,
  (params: Params | undefined) => Reply | Promise<Reply>
>

const CONTRACT = StellarContractAddress.make("CCAANR7HZNOXYZD7SXS2WQLV5BAOXSRZ7V4O43IANSB355QN2RNG7WVC")
const OTHER = StellarContractAddress.make(StrKey.encodeContract(Buffer.alloc(32, 1)))
const TX_HASH = "3fcd635d285c5b3a4d9b65a10f6c70c11132d8fafd32e82fea79103eb1a05924"

const toid = (ledger: number) => BigInt(ledger) << BigInt(32)
const eventId = (ledger: number, index = 0) =>
  `${toid(ledger).toString().padStart(19, "0")}-${String(index).padStart(10, "0")}`
// the RPC's cursor at the end of a scanned window: the largest cursor in `ledger`
const windowEnd = (ledger: number) => `${(toid(ledger) | BigInt(0xffffffff)).toString().padStart(19, "0")}-4294967295`

const baseEvent = {
  type: "contract",
  ledger: 10,
  ledgerClosedAt: "2026-07-21T20:44:01Z",
  contractId: CONTRACT,
  id: eventId(10),
  operationIndex: 0,
  transactionIndex: 1,
  txHash: TX_HASH,
  inSuccessfulContractCall: true,
  topic: ["AAAADwAAAAh0cmFuc2Zlcg=="],
  value: "AAAACgAAAAAAAAAAAAAAAAAAASw="
}

const rawEvent = (overrides: { readonly [K in keyof typeof baseEvent]?: Schema.Json } = {}) => ({
  ...baseEvent,
  id: eventId(Number(overrides.ledger ?? baseEvent.ledger)),
  ...overrides
})

const health = (latestLedger: number, oldestLedger = 1) => () => ({
  result: { status: "healthy", latestLedger, oldestLedger }
})
const page = (events: Array<Schema.Json>, cursor: string, latestLedger = 100) => () => ({
  result: { events, cursor, latestLedger, oldestLedger: 1 }
})

const defaults: Node = {
  getNetwork: () => ({ result: { passphrase: toPassphrase("Stellar"), protocolVersion: 23 } }),
  getHealth: health(100),
  getEvents: page([], windowEnd(20))
}

// one fake fetch serving every endpoint, routed by host: `https://<name>.rpc.test/secret-key`
const setup = (nodes: Record<string, Node>) => {
  const calls: Array<string> = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const name = new URL(String(input)).hostname.split(".")[0]
    const body: { id: number; method: string; params?: Params } = JSON.parse(String(init?.body))
    calls.push(`${name}:${body.method}`)
    const handler = nodes[name]?.[body.method] ?? defaults[body.method]
    const reply = handler === undefined
      ? { error: { code: -32601, message: "method not found" } }
      : await handler(body.params)
    return reply instanceof Response ? reply : Response.json({ jsonrpc: "2.0", id: body.id, ...reply })
  }
  const names = Object.keys(nodes)
  if (!Arr.isReadonlyArrayNonEmpty(names)) throw new Error("setup needs at least one endpoint")
  const layer = StellarRpc.layer({
    network: "Stellar",
    endpoints: Arr.map(names, (name) => ({ name, url: Redacted.make(`https://${name}.rpc.test/secret-key`) })),
    retries: 0
  }).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)))
  const run = <A, E>(f: (rpc: StellarRpc.StellarRpc["Service"]) => Effect.Effect<A, E>) =>
    Effect.gen(function*() {
      return yield* f(yield* StellarRpc.StellarRpc)
    }).pipe(Effect.provide(layer))
  return { calls, fetch, run }
}

const filter = { contractIds: [CONTRACT] as const, fromBlock: BigInt(10), toBlock: BigInt(20) }

describe("StellarContractEvent", () => {
  it("decodes a raw getEvents event and encodes it back", () => {
    const event = Schema.decodeUnknownSync(StellarContractEvent)(rawEvent())
    expect(event).toStrictEqual({
      id: eventId(10),
      type: "contract",
      contractId: CONTRACT,
      topics: baseEvent.topic,
      value: baseEvent.value,
      blockNumber: BigInt(10),
      ledgerClosedAt: baseEvent.ledgerClosedAt,
      transactionHash: `0x${TX_HASH}`,
      inSuccessfulContractCall: true
    })
    const { operationIndex: _operationIndex, transactionIndex: _transactionIndex, ...encoded } = rawEvent()
    expect(Schema.encodeSync(StellarContractEvent)(event)).toStrictEqual(encoded)
  })

  it("defaults the fields the RPC leaves out", () => {
    const { topic: _topic, inSuccessfulContractCall: _success, ...bare } = rawEvent()
    const event = Schema.decodeUnknownSync(StellarContractEvent)(bare)
    expect(event.topics).toStrictEqual([])
    expect(event.inSuccessfulContractCall).toBe(true)
    expect(Schema.decodeUnknownSync(StellarContractEvent)(rawEvent({ inSuccessfulContractCall: false }))).toMatchObject(
      { inSuccessfulContractCall: false }
    )
  })

  it("rejects malformed events", () => {
    for (const overrides of [{ ledger: "10" }, { id: "1-2" }, { contractId: "GABC" }, { txHash: "zz" }]) {
      expect(() => Schema.decodeUnknownSync(StellarContractEvent)(rawEvent(overrides))).toThrow()
    }
  })
})

describe("StellarRpc", () => {
  it.effect("decodes getNetwork, getLatestLedger and getEvents", () => {
    const { calls, run } = setup({
      a: {
        getLatestLedger: () => ({ result: { id: "ab".repeat(32), protocolVersion: 23, sequence: 100 } }),
        getEvents: page([rawEvent()], windowEnd(20))
      }
    })
    return run((rpc) =>
      Effect.gen(function*() {
        expect(yield* rpc.getNetwork).toStrictEqual({
          passphrase: toPassphrase("Stellar"),
          protocolVersion: 23
        })
        expect(yield* rpc.getLatestLedger).toStrictEqual({
          id: "ab".repeat(32),
          protocolVersion: 23,
          sequence: BigInt(100)
        })
        expect(yield* rpc.getEvents(filter)).toStrictEqual({
          events: [Schema.decodeUnknownSync(StellarContractEvent)(rawEvent())],
          cursor: undefined
        })
        // getLatestLedger's 100 covers toBlock 20: no getHealth
        expect(calls).toStrictEqual(["a:getNetwork", "a:getLatestLedger", "a:getEvents"])
      })
    )
  })

  it.effect("encodes getEvents params", () => {
    const params: Array<Params | undefined> = []
    const { run } = setup({
      a: {
        getEvents: (p) => {
          params.push(p)
          return { result: { events: [], cursor: windowEnd(15), latestLedger: 100 } }
        }
      }
    })
    return run((rpc) =>
      Effect.gen(function*() {
        const first = yield* rpc.getEvents({ ...filter, topics: [["AAAADwAAAAh0cmFuc2Zlcg==", "*", "**"]] })
        assert.isDefined(first.cursor)
        yield* rpc.getEvents({ ...filter, limit: 10, cursor: first.cursor })
        expect(params).toStrictEqual([
          {
            startLedger: 10,
            endLedger: 21,
            filters: [{ type: "contract", contractIds: [CONTRACT], topics: [["AAAADwAAAAh0cmFuc2Zlcg==", "*", "**"]] }],
            pagination: { limit: 1000 }
          },
          // undefined is not JSON: no topics key, and no ledger bounds with a cursor
          {
            filters: [{ type: "contract", contractIds: [CONTRACT] }],
            pagination: { limit: 10, cursor: windowEnd(15) }
          }
        ])
      })
    )
  })

  it.effect("sends no params to methods without params", () => {
    let sent: Params | undefined | "unset" = "unset"
    const { run } = setup({
      a: {
        getLatestLedger: (p) => {
          sent = p
          return { result: { id: "ab", protocolVersion: 23, sequence: 1 } }
        }
      }
    })
    return run((rpc) => rpc.getLatestLedger).pipe(Effect.map(() => expect(sent).toBeUndefined()))
  })

  it.effect("maps the chain error codes to reasons", () =>
    Effect.gen(function*() {
      for (const [code, reason] of [[-32603, "Unavailable"], [-32602, "Rejected"]] as const) {
        const { run } = setup({ a: { getLatestLedger: () => ({ error: { code, message: "boom" } }) } })
        const error = yield* run((rpc) => Effect.flip(rpc.getLatestLedger))
        expect(error).toMatchObject({ reason, code })
        expect(error.message).toBe(`getLatestLedger failed on a: ${reason} (${code})`)
      }
    }))

  it.effect("fails WrongNetwork on a network mismatch", () => {
    const testnet = toPassphrase("StellarTestnet")
    const { calls, run } = setup({
      a: { getNetwork: () => ({ result: { passphrase: testnet, protocolVersion: 23 } }) },
      b: {}
    })
    return run((rpc) => Effect.flip(rpc.getLatestLedger)).pipe(Effect.map((error) => {
      expect(error).toMatchObject({ reason: "WrongNetwork", method: "getNetwork", endpoint: "a" })
      expect(error.message).toBe("getNetwork failed on a: WrongNetwork")
      assert.instanceOf(error.cause, Error)
      expect(error.cause.message).toBe(`expected passphrase "${toPassphrase("Stellar")}" for Stellar, got "${testnet}"`)
      expect(calls).toStrictEqual(["a:getNetwork"])
    }))
  })

  it.effect("falls back to the next endpoint through the layer", () => {
    const { calls, run } = setup({
      a: { getLatestLedger: () => new Response("down", { status: 503 }) },
      b: { getLatestLedger: () => ({ result: { id: "ab", protocolVersion: 23, sequence: 7 } }) }
    })
    return run((rpc) => rpc.getLatestLedger).pipe(Effect.map((ledger) => {
      expect(ledger.sequence).toBe(BigInt(7))
      expect(calls).toStrictEqual(["a:getNetwork", "a:getLatestLedger", "b:getNetwork", "b:getLatestLedger"])
    }))
  })

  it.effect("skips a lagging endpoint and remembers heads", () => {
    const events = page([rawEvent()], windowEnd(20))
    const { calls, run } = setup({
      a: { getHealth: health(15), getEvents: events },
      b: { getHealth: health(30), getEvents: events }
    })
    return run((rpc) =>
      Effect.gen(function*() {
        expect((yield* rpc.getEvents(filter)).events).toHaveLength(1)
        expect(calls).toStrictEqual(["a:getNetwork", "a:getHealth", "b:getNetwork", "b:getHealth", "b:getEvents"])
        calls.length = 0
        yield* rpc.getEvents({ ...filter, toBlock: BigInt(12) })
        // a's known head 15 covers ledger 12: no getHealth
        expect(calls).toStrictEqual(["a:getEvents"])
      })
    )
  })

  it.effect("skips an endpoint that pruned fromBlock", () => {
    const { calls, run } = setup({ a: { getHealth: health(100, 11) }, b: { getEvents: page([], windowEnd(20)) } })
    return run((rpc) => rpc.getEvents(filter)).pipe(Effect.map(() => {
      expect(calls).toStrictEqual(["a:getNetwork", "a:getHealth", "b:getNetwork", "b:getHealth", "b:getEvents"])
    }))
  })

  it.effect("maps the RPC's out-of-range start to Pruned or Lagging", () =>
    Effect.gen(function*() {
      for (
        const [message, reason] of [
          ["startLedger must be within the ledger range: 11 - 100", "Pruned"],
          [
            "startLedger must be between the oldest ledger: 11 and the latest ledger: 100 for this rpc instance.",
            "Pruned"
          ],
          ["startLedger must be within the ledger range: 1 - 9", "Lagging"]
        ]
      ) {
        const { run } = setup({ a: { getEvents: () => ({ error: { code: -32600, message } }) } })
        const error = yield* run((rpc) => Effect.flip(rpc.getEvents(filter)))
        expect(error, message).toMatchObject({ reason, code: -32600 })
      }
    }))

  it.effect("returns Lagging when no endpoint reached toBlock", () =>
    setup({ a: { getHealth: health(15) } }).run((rpc) => Effect.flip(rpc.getEvents(filter))).pipe(
      Effect.map((error) => expect(error).toMatchObject({ reason: "Lagging", method: "getEvents" }))
    ))

  it.effect("returns a cursor until the cursor passes toBlock", () =>
    Effect.gen(function*() {
      const cursorOf = (reply: Node[string], limit?: number) =>
        setup({ a: { getEvents: reply } }).run((rpc) =>
          rpc.getEvents({ ...filter, limit }).pipe(Effect.map((page) => page.cursor))
        )
      // the RPC scanned up to ledger 15 only (its 10000-ledger window)
      expect(yield* cursorOf(page([], windowEnd(15)))).toStrictEqual({ endpoint: "a", cursor: windowEnd(15) })
      // a short page whose window ends at toBlock
      expect(yield* cursorOf(page([rawEvent()], windowEnd(20)))).toBeUndefined()
      // a full page ending at toBlock: more events of toBlock may follow
      expect(yield* cursorOf(page([rawEvent({ ledger: 20 })], eventId(20)), 1)).toStrictEqual({
        endpoint: "a",
        cursor: eventId(20)
      })
    }))

  it.effect("continues from a cursor on its endpoint only, dropping events above toBlock", () => {
    const pages = [page([], windowEnd(15)), page([rawEvent({ ledger: 20 }), rawEvent({ ledger: 21 })], windowEnd(25))]
    const { calls, run } = setup({
      // a lags, so the first page comes from b
      a: { getHealth: health(15) },
      b: { getEvents: () => (pages.shift() ?? page([], windowEnd(25)))() }
    })
    return run((rpc) =>
      Effect.gen(function*() {
        const first = yield* rpc.getEvents(filter)
        expect(first.cursor).toStrictEqual({ endpoint: "b", cursor: windowEnd(15) })
        calls.length = 0
        const next = yield* rpc.getEvents({ ...filter, cursor: first.cursor })
        // no guard, no fallback: straight to b
        expect(calls).toStrictEqual(["b:getEvents"])
        expect(next.events.map((event) => event.blockNumber)).toStrictEqual([BigInt(20)])
        expect(next.cursor).toBeUndefined()
      })
    )
  })

  it.effect("fails a cursor from an unknown endpoint without a request", () => {
    const { calls, run } = setup({ a: {} })
    const cursor = StellarRpc.StellarEventsCursor.make({ endpoint: "gone", cursor: windowEnd(15) })
    return run((rpc) => Effect.flip(rpc.getEvents({ ...filter, cursor }))).pipe(Effect.map((error) => {
      expect(error).toMatchObject({ reason: "Rejected", endpoint: "gone" })
      assert.instanceOf(error.cause, Error)
      expect(error.cause.message).toBe("no endpoint named gone")
      expect(calls).toStrictEqual([])
    }))
  })

  it.effect("does not fall back with a cursor", () => {
    let calls = 0
    const { run } = setup({
      a: {
        getEvents: () => ++calls === 1 ? page([], windowEnd(15))() : new Response("down", { status: 503 })
      },
      b: {}
    })
    return run((rpc) =>
      rpc.getEvents(filter).pipe(
        Effect.flatMap((first) => Effect.flip(rpc.getEvents({ ...filter, cursor: first.cursor }))),
        Effect.map((error) => expect(error).toMatchObject({ reason: "Unavailable", endpoint: "a" }))
      )
    )
  })

  it.effect("fails Lagging when a cursor page stops at the endpoint's latest ledger", () =>
    setup({ a: { getEvents: page([], windowEnd(15), 15), getHealth: health(100) } }).run((rpc) =>
      Effect.flip(rpc.getEvents(filter)).pipe(
        Effect.map((error) => expect(error).toMatchObject({ reason: "Lagging" }))
      )
    ))

  it.effect("rejects foreign, out-of-range and non-contract events", () =>
    Effect.gen(function*() {
      for (const bad of [{ contractId: OTHER }, { ledger: 9 }, { type: "system" }]) {
        const { run } = setup({ a: { getEvents: page([rawEvent(bad)], windowEnd(20)) } })
        expect((yield* run((rpc) => Effect.flip(rpc.getEvents(filter)))).reason, JSON.stringify(bad)).toBe(
          "InvalidResponse"
        )
      }
    }))

  it.effect("sorts events by id", () => {
    const { run } = setup({
      a: {
        getEvents: page([
          rawEvent({ ledger: 12 }),
          rawEvent({ ledger: 11, id: eventId(11, 1) }),
          rawEvent({ ledger: 11 })
        ], windowEnd(20))
      }
    })
    return run((rpc) => rpc.getEvents(filter)).pipe(
      Effect.map(({ events }) =>
        expect(events.map((event) => event.id)).toStrictEqual([eventId(11), eventId(11, 1), eventId(12)])
      )
    )
  })

  it.effect("makes no call for an empty range", () => {
    const { calls, run } = setup({ a: {} })
    const empty = { ...filter, fromBlock: BigInt(21) }
    // the empty range is checked before the cursor, even one from an unknown endpoint
    const cursor = StellarRpc.StellarEventsCursor.make({ endpoint: "gone", cursor: windowEnd(15) })
    return run((rpc) => Effect.all([rpc.getEvents(empty), rpc.getEvents({ ...empty, cursor })])).pipe(
      Effect.map((results) => {
        expect(results).toStrictEqual([{ events: [], cursor: undefined }, { events: [], cursor: undefined }])
        expect(calls).toStrictEqual([])
      })
    )
  })
})

describe("layerConfig", () => {
  const endpoints = Config.all([Config.all({ name: Config.succeed("a"), url: Config.Redacted("STELLAR_RPC_URL") })])
  const run = (env: Record<string, string>) => {
    const { calls, fetch } = setup({
      a: { getLatestLedger: () => ({ result: { id: "ab".repeat(32), protocolVersion: 23, sequence: 100 } }) }
    })
    const layer = StellarRpc.layerConfig({ network: Config.succeed("Stellar"), endpoints, retries: Config.succeed(0) })
      .pipe(
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env)))
      )
    return {
      calls,
      effect: Effect.gen(function*() {
        return yield* (yield* StellarRpc.StellarRpc).getLatestLedger
      }).pipe(Effect.provide(layer))
    }
  }

  it.effect("builds from config", () =>
    Effect.gen(function*() {
      const { calls, effect } = run({ STELLAR_RPC_URL: "https://a.rpc.test/secret-key" })
      expect(yield* effect).toStrictEqual({ id: "ab".repeat(32), protocolVersion: 23, sequence: BigInt(100) })
      expect(calls.length).toBeGreaterThan(0)
    }))

  it.effect("fails with a ConfigError when a value is missing", () =>
    Effect.gen(function*() {
      const { calls, effect } = run({})
      expect(yield* Effect.flip(effect)).toMatchObject({ _tag: "ConfigError" })
      expect(calls).toStrictEqual([])
    }))

  it("keeps the endpoint url redacted", () => {
    StellarRpc.layerConfig({
      network: Config.succeed("Stellar"),
      // @ts-expect-error a plain string url is rejected
      endpoints: Config.all([Config.all({ name: Config.succeed("a"), url: Config.String("STELLAR_RPC_URL") })])
    })
  })
})
