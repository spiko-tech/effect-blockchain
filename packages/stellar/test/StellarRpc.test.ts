import { StellarContractAddress } from "@effect-blockchain/stellar/StellarAddress"
import { StellarContractEvent } from "@effect-blockchain/stellar/StellarContractEvent"
import { toPassphrase } from "@effect-blockchain/stellar/StellarNetwork"
import * as StellarRpc from "@effect-blockchain/stellar/StellarRpc"
import { assert, describe, expect, it } from "@effect/vitest"
import { StrKey } from "@stellar/stellar-sdk"
import * as Arr from "effect/Array"
import * as Clock from "effect/Clock"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as Tracer from "effect/Tracer"

type Params = { readonly [key: string]: Schema.Json }
type Reply = { readonly result: Schema.Json } | { readonly error: { code: number; message: string } } | Response
type Node = Record<
  string,
  (params: Params | undefined, signal: AbortSignal | null | undefined) => Reply | Promise<Reply>
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
const setup = (
  nodes: Record<string, Node>,
  options: { readonly retries?: number; readonly timeout?: Duration.Input; readonly layerDefaults?: boolean } = {}
) => {
  const calls: Array<string> = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const name = new URL(String(input)).hostname.split(".")[0]
    const body: { id: number; method: string; params?: Params } = JSON.parse(String(init?.body))
    calls.push(`${name}:${body.method}`)
    const handler = nodes[name]?.[body.method] ?? defaults[body.method]
    const reply = handler === undefined
      ? { error: { code: -32601, message: "method not found" } }
      : await handler(body.params, init?.signal)
    return reply instanceof Response ? reply : Response.json({ jsonrpc: "2.0", id: body.id, ...reply })
  }
  const names = Object.keys(nodes)
  if (!Arr.isReadonlyArrayNonEmpty(names)) throw new Error("setup needs at least one endpoint")
  const layer = StellarRpc.layer({
    network: "Stellar",
    endpoints: Arr.map(names, (name) => ({ name, url: Redacted.make(`https://${name}.rpc.test/secret-key`) })),
    ...(options.layerDefaults
      ? {}
      : { retries: options.retries ?? 0, retryDelay: "1 millis", timeout: options.timeout })
  }).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)))
  const run = <A, E>(f: (rpc: StellarRpc.StellarRpc["Service"]) => Effect.Effect<A, E>) =>
    Effect.gen(function*() {
      return yield* f(yield* StellarRpc.StellarRpc)
    }).pipe(Effect.provide(layer))
  return { calls, run }
}

// like fetch, hang until aborted
const hang: Node[string] = (_, signal) =>
  new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason)))

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

  const failure = (reply: Node[string], options?: { readonly timeout?: Duration.Input }) =>
    setup({ a: { getLatestLedger: reply } }, options).run((rpc) => Effect.flip(rpc.getLatestLedger))

  it.effect("classifies HTTP 429 and 503 as Unavailable", () =>
    Effect.gen(function*() {
      for (const status of [429, 503]) {
        const error = yield* failure(() => new Response("busy", { status }))
        expect(error).toMatchObject({ reason: "Unavailable", code: status, method: "getLatestLedger", endpoint: "a" })
      }
    }))

  it.live("classifies a timeout and a transport error as Unavailable", () =>
    Effect.gen(function*() {
      const timedOut = yield* failure(hang, { timeout: "20 millis" })
      expect(timedOut.reason).toBe("Unavailable")
      assert.instanceOf(timedOut.cause, Error)
      expect(timedOut.cause.message).toBe("timed out after 20ms")
      const down = () => Promise.reject(new TypeError("fetch failed: https://a.rpc.test/secret-key"))
      expect((yield* failure(down)).reason).toBe("Unavailable")
    }))

  it.effect("classifies JSON-RPC codes", () =>
    Effect.gen(function*() {
      const rejected = yield* failure(() => ({ error: { code: -32602, message: "invalid params" } }))
      expect(rejected).toMatchObject({ reason: "Rejected", code: -32602 })
      const internal = yield* failure(() => ({ error: { code: -32603, message: "database is locked" } }))
      expect(internal).toMatchObject({ reason: "Unavailable", code: -32603 })
    }))

  it.effect("classifies an invalid result or a non-JSON body as InvalidResponse", () =>
    Effect.gen(function*() {
      for (
        const reply of [
          () => ({ result: { sequence: "twenty" } }),
          () => new Response("<html>"),
          () => Response.json({ jsonrpc: "2.0", id: 1 })
        ]
      ) {
        expect((yield* failure(reply)).reason).toBe("InvalidResponse")
      }
    }))

  it.effect("keeps the URL out of errors", () =>
    Effect.gen(function*() {
      // every message, stack and JSON in the cause chain, through AggregateError members
      const texts = (error: Error): Array<string> => [
        error.message,
        error.stack ?? "",
        JSON.stringify(error),
        ...(error.cause instanceof Error ? texts(error.cause) : []),
        ...(error instanceof AggregateError ? error.errors.filter((e) => e instanceof Error).flatMap(texts) : [])
      ]
      const transport = () => Promise.reject(new TypeError("fetch failed: https://a.rpc.test/secret-key"))
      const errors = [
        yield* failure(() => new Response("busy", { status: 503 })),
        yield* failure(transport),
        yield* failure(() => new Response("<html>")),
        yield* setup({ a: { getLatestLedger: transport }, b: { getLatestLedger: transport } }).run((rpc) =>
          Effect.flip(rpc.getLatestLedger)
        )
      ]
      for (const error of errors) {
        for (const text of texts(error)) expect(text).not.toContain("secret-key")
      }
    }))

  it.live("retries transient errors before falling back", () =>
    Effect.gen(function*() {
      let attempts = 0
      const flaky = setup({
        a: {
          getLatestLedger: () =>
            ++attempts === 1
              ? new Response("busy", { status: 503 })
              : { error: { code: -32603, message: "database is locked" } }
        },
        b: { getLatestLedger: () => ({ result: { id: "ab", protocolVersion: 23, sequence: 5 } }) }
      }, { retries: 2 })
      expect((yield* flaky.run((rpc) => rpc.getLatestLedger)).sequence).toBe(BigInt(5))
      expect(flaky.calls).toStrictEqual([
        "a:getNetwork",
        "a:getLatestLedger",
        "a:getLatestLedger",
        "a:getLatestLedger",
        "b:getNetwork",
        "b:getLatestLedger"
      ])

      const rejected = setup(
        { a: { getLatestLedger: () => ({ error: { code: -32602, message: "invalid params" } }) } },
        {
          retries: 2
        }
      )
      yield* rejected.run((rpc) => Effect.flip(rpc.getLatestLedger))
      expect(rejected.calls).toStrictEqual(["a:getNetwork", "a:getLatestLedger"])
    }))

  it.live("does not retry a timeout and falls back", () =>
    Effect.gen(function*() {
      let aborted = false
      const { calls, run } = setup({
        a: {
          getLatestLedger: (params, signal) => {
            signal?.addEventListener("abort", () => aborted = true)
            return hang(params, signal)
          }
        },
        b: { getLatestLedger: () => ({ result: { id: "ab", protocolVersion: 23, sequence: 5 } }) }
      }, { retries: 2, timeout: "20 millis" })
      expect((yield* run((rpc) => rpc.getLatestLedger)).sequence).toBe(BigInt(5))
      expect(calls).toStrictEqual(["a:getNetwork", "a:getLatestLedger", "b:getNetwork", "b:getLatestLedger"])
      expect(aborted).toBe(true)
    }))

  it.live("uses the default retries and retry delay", () =>
    Effect.gen(function*() {
      let attempts = 0
      const { calls, run } = setup({
        a: {
          getLatestLedger: () =>
            ++attempts <= 2
              ? new Response("busy", { status: 503 })
              : { result: { id: "ab", protocolVersion: 23, sequence: 5 } }
        }
      }, { layerDefaults: true })
      expect((yield* run((rpc) => rpc.getLatestLedger)).sequence).toBe(BigInt(5))
      expect(calls).toStrictEqual(["a:getNetwork", "a:getLatestLedger", "a:getLatestLedger", "a:getLatestLedger"])
    }))

  it.live("waits for Retry-After", () =>
    Effect.gen(function*() {
      let attempts = 0
      const { calls, run } = setup({
        a: {
          getLatestLedger: () =>
            ++attempts === 1
              ? new Response("slow down", { status: 429, headers: { "retry-after": "1" } })
              : { result: { id: "ab", protocolVersion: 23, sequence: 5 } }
        }
      }, { retries: 1 })
      const start = yield* Clock.currentTimeMillis
      expect((yield* run((rpc) => rpc.getLatestLedger)).sequence).toBe(BigInt(5))
      expect((yield* Clock.currentTimeMillis) - start).toBeGreaterThanOrEqual(1000)
      expect(calls).toStrictEqual(["a:getNetwork", "a:getLatestLedger", "a:getLatestLedger"])
    }))

  it.effect("does not retry a 403 and falls back", () => {
    const { calls, run } = setup({
      a: { getLatestLedger: () => new Response("forbidden", { status: 403 }) },
      b: { getLatestLedger: () => ({ result: { id: "ab", protocolVersion: 23, sequence: 5 } }) }
    }, { retries: 2 })
    return run((rpc) => rpc.getLatestLedger).pipe(Effect.map((ledger) => {
      expect(ledger.sequence).toBe(BigInt(5))
      expect(calls).toStrictEqual(["a:getNetwork", "a:getLatestLedger", "b:getNetwork", "b:getLatestLedger"])
    }))
  })

  it.effect("fails Rejected without a request when params do not encode", () => {
    const { calls, run } = setup({ a: {} })
    const cursor = StellarRpc.StellarEventsCursor.make({ endpoint: "a", cursor: "not-a-cursor" })
    return run((rpc) =>
      Effect.gen(function*() {
        yield* rpc.getNetwork
        calls.length = 0
        expect(yield* Effect.flip(rpc.getEvents({ ...filter, cursor }))).toMatchObject({
          reason: "Rejected",
          method: "getEvents",
          endpoint: "a"
        })
        expect(calls).toStrictEqual([])
      })
    )
  })

  it.effect("records one span per request without the URL", () => {
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      }
    })
    const { run } = setup({
      a: { getLatestLedger: () => ({ result: { id: "ab", protocolVersion: 23, sequence: 5 } }) }
    })
    return run((rpc) => rpc.getLatestLedger).pipe(
      Effect.provide(Layer.succeed(Tracer.Tracer, tracer)),
      Effect.map(() => {
        expect(spans.map((span) => [span.name, Object.fromEntries(span.attributes)])).toStrictEqual([
          ["StellarRpc.getNetwork", { network: "Stellar", endpoint: "a", method: "getNetwork" }],
          ["StellarRpc.getLatestLedger", { network: "Stellar", endpoint: "a", method: "getLatestLedger" }]
        ])
        for (const span of spans) {
          expect(`${span.name} ${JSON.stringify([...span.attributes])}`).not.toContain("secret-key")
        }
      })
    )
  })

  it.effect("falls back in order and stops on Rejected", () =>
    Effect.gen(function*() {
      const down = () => new Response("down", { status: 503 })
      const latest = () => ({ result: { id: "ab", protocolVersion: 23, sequence: 7 } })
      const fallback = setup({ a: { getLatestLedger: down }, b: { getLatestLedger: latest } })
      expect((yield* fallback.run((rpc) => rpc.getLatestLedger)).sequence).toBe(BigInt(7))
      expect(fallback.calls).toStrictEqual(["a:getNetwork", "a:getLatestLedger", "b:getNetwork", "b:getLatestLedger"])

      const rejected = () => ({ error: { code: -32602, message: "invalid params" } })
      const stop = setup({ a: { getLatestLedger: rejected }, b: { getLatestLedger: latest } })
      expect((yield* stop.run((rpc) => Effect.flip(rpc.getLatestLedger))).reason).toBe("Rejected")
      expect(stop.calls).toStrictEqual(["a:getNetwork", "a:getLatestLedger"])
    }))

  it.effect("fails with the last error and keeps the others when every endpoint fails", () =>
    Effect.gen(function*() {
      const { run } = setup({
        a: { getLatestLedger: () => new Response("down", { status: 503 }) },
        b: { getLatestLedger: () => ({ result: "nope" }) }
      })
      const error = yield* run((rpc) => Effect.flip(rpc.getLatestLedger))
      expect(error).toMatchObject({ reason: "InvalidResponse", endpoint: "b" })
      assert.instanceOf(error.cause, AggregateError)
      expect(error.cause.errors).toMatchObject([{ endpoint: "a" }, { endpoint: "b" }])
    }))

  it.effect("falls back after an invalid response and succeeds on the next endpoint", () => {
    const { calls, run } = setup({
      a: { getLatestLedger: () => ({ result: "nope" }) },
      b: { getLatestLedger: () => ({ result: { id: "ab", protocolVersion: 23, sequence: 7 } }) }
    })
    return run((rpc) => rpc.getLatestLedger).pipe(Effect.map((ledger) => {
      expect(ledger.sequence).toBe(BigInt(7))
      expect(calls).toStrictEqual(["a:getNetwork", "a:getLatestLedger", "b:getNetwork", "b:getLatestLedger"])
    }))
  })

  it.effect("checks the network once per endpoint and caches a mismatch", () =>
    Effect.gen(function*() {
      const ok = setup({ a: {} })
      yield* ok.run((rpc) => Effect.zip(rpc.getNetwork, rpc.getEvents(filter)))
      expect(ok.calls.filter((call) => call.endsWith("getNetwork"))).toHaveLength(1)

      const testnet = () => ({
        result: { passphrase: toPassphrase("StellarTestnet"), protocolVersion: 23 }
      })
      const wrong = setup({ a: { getNetwork: testnet }, b: {} })
      const errors = yield* wrong.run((rpc) =>
        Effect.zip(Effect.flip(rpc.getLatestLedger), Effect.flip(rpc.getLatestLedger))
      )
      expect(errors.map((error) => error.reason)).toStrictEqual(["WrongNetwork", "WrongNetwork"])
      expect(wrong.calls).toStrictEqual(["a:getNetwork"])
    }))

  it.effect("does not cache a failed network check", () => {
    let attempts = 0
    const { calls, run } = setup({
      a: { getNetwork: (p, s) => ++attempts === 1 ? new Response("down", { status: 503 }) : defaults.getNetwork(p, s) }
    })
    return run((rpc) => Effect.zip(Effect.flip(rpc.getNetwork), rpc.getNetwork)).pipe(Effect.map(([error]) => {
      expect(error.reason).toBe("Unavailable")
      expect(calls).toStrictEqual(["a:getNetwork", "a:getNetwork"])
    }))
  })

  it.effect("runs one network check for concurrent first calls", () => {
    const { calls, run } = setup({
      a: { getLatestLedger: () => ({ result: { id: "ab", protocolVersion: 23, sequence: 5 } }) }
    })
    return run((rpc) => Effect.all([rpc.getLatestLedger, rpc.getLatestLedger], { concurrency: "unbounded" })).pipe(
      Effect.map(() => expect(calls).toStrictEqual(["a:getNetwork", "a:getLatestLedger", "a:getLatestLedger"]))
    )
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
