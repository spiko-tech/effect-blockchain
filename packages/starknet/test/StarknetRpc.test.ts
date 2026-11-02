import { StarknetAddress } from "@effect-blockchain/starknet/StarknetAddress"
import { StarknetEvent } from "@effect-blockchain/starknet/StarknetEvent"
import * as StarknetRpc from "@effect-blockchain/starknet/StarknetRpc"
import { StarknetTransactionHash } from "@effect-blockchain/starknet/StarknetTransactionHash"
import { assert, describe, expect, it } from "@effect/vitest"
import * as Arr from "effect/Array"
import * as Clock from "effect/Clock"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as Tracer from "effect/Tracer"

type Reply = { readonly result: Schema.Json } | { readonly error: { code: number; message: string } } | Response
type Node = Record<
  string,
  (params: Schema.Json, signal: AbortSignal | null | undefined) => Reply | Promise<Reply>
>

const TOKEN = StarknetAddress.make("0x" + "11".repeat(32))
const OTHER = StarknetAddress.make("0x" + "22".repeat(32))
const TX = StarknetTransactionHash.make("0x" + "cd".repeat(32))
const SN_MAIN = "0x534e5f4d41494e"

const baseEvent = {
  from_address: TOKEN,
  keys: ["0x99cd8bde557814842a3121e8ddfd433a539b8c9f14bf31ebf108d12e6196e9"],
  data: ["0x1", "0x2"],
  block_number: 10,
  block_hash: "0x" + "ab".repeat(32),
  transaction_hash: TX
}

const rawEvent = (overrides: { readonly [K in keyof typeof baseEvent]?: Schema.Json } = {}) => ({
  ...baseEvent,
  ...overrides
})

const defaults: Node = { starknet_chainId: () => ({ result: SN_MAIN }) }

// one fake fetch serving every endpoint, routed by host: `https://<name>.rpc.test/secret-key`
const setup = (
  nodes: Record<string, Node>,
  // `defaults` builds the layer without retries, retryDelay and timeout
  options: { readonly retries?: number; readonly timeout?: Duration.Input; readonly defaults?: boolean } = {}
) => {
  const calls: Array<string> = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const name = new URL(String(input)).hostname.split(".")[0]
    const body: { id: number; method: string; params: Schema.Json } = JSON.parse(
      await new Response(init?.body).text()
    )
    calls.push(`${name}:${body.method}`)
    const handler = nodes[name]?.[body.method] ?? defaults[body.method]
    const reply = handler === undefined
      ? { error: { code: -32601, message: "method not found" } }
      : await handler(body.params, init?.signal)
    return reply instanceof Response ? reply : Response.json({ jsonrpc: "2.0", id: body.id, ...reply })
  }
  const names = Object.keys(nodes)
  if (!Arr.isReadonlyArrayNonEmpty(names)) throw new Error("setup needs at least one endpoint")
  const layer = StarknetRpc.layer({
    network: "Starknet",
    endpoints: Arr.map(names, (name) => ({ name, url: Redacted.make(`https://${name}.rpc.test/secret-key`) })),
    ...(!options.defaults && { retries: options.retries ?? 0, retryDelay: "1 millis", timeout: options.timeout })
  }).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)))
  const run = <A, E>(f: (rpc: StarknetRpc.StarknetRpc["Service"]) => Effect.Effect<A, E>) =>
    Effect.gen(function*() {
      return yield* f(yield* StarknetRpc.StarknetRpc)
    }).pipe(Effect.provide(layer))
  return { calls, run }
}

const filter = { address: TOKEN, fromBlock: BigInt(10), toBlock: BigInt(20) }
const head = (block: number) => () => ({ result: block })

describe("StarknetEvent", () => {
  it("decodes a raw JSON-RPC event and normalizes felts", () => {
    const event = Schema.decodeUnknownSync(StarknetEvent)({ ...rawEvent(), event_index: 3 })
    expect(event.blockNumber).toBe(BigInt(10))
    expect(event.data).toStrictEqual(["0x" + "0".repeat(63) + "1", "0x" + "0".repeat(63) + "2"])
    expect(event.eventIndex).toBe(3)
    expect(event.transactionIndex).toBeUndefined()
  })

  it("rejects a pre-confirmed event and malformed fields", () => {
    for (const overrides of [{ block_number: null }, { block_hash: null }, { block_number: "0xa" }, { keys: ["x"] }]) {
      expect(() => Schema.decodeUnknownSync(StarknetEvent)(rawEvent(overrides))).toThrow()
    }
  })
})

describe("StarknetRpc", () => {
  it.effect("decodes chainId, blockNumber, getEvents and getTransactionReceipt", () => {
    const { run } = setup({
      a: {
        starknet_blockNumber: head(20),
        starknet_getEvents: () => ({ result: { events: [rawEvent()] } }),
        starknet_getTransactionReceipt: () => ({
          result: {
            transaction_hash: TX,
            block_number: 10,
            block_hash: baseEvent.block_hash,
            finality_status: "ACCEPTED_ON_L2",
            events: [{ from_address: TOKEN, keys: ["0x1"], data: [] }]
          }
        })
      }
    })
    return run((rpc) =>
      Effect.gen(function*() {
        expect(yield* rpc.chainId).toBe("SN_MAIN")
        expect(yield* rpc.blockNumber).toBe(BigInt(20))
        expect(yield* rpc.getEvents(filter)).toStrictEqual({
          events: [Schema.decodeUnknownSync(StarknetEvent)(rawEvent())],
          cursor: undefined
        })
        expect(yield* rpc.getTransactionReceipt({ transactionHash: TX })).toStrictEqual({
          transactionHash: TX,
          blockNumber: BigInt(10),
          blockHash: baseEvent.block_hash,
          events: [{ fromAddress: TOKEN, keys: ["0x" + "0".repeat(63) + "1"], data: [] }]
        })
      })
    )
  })

  it.effect("encodes getEvents params by name", () => {
    let params: Schema.Json = null
    const { run } = setup({
      a: {
        starknet_blockNumber: head(20),
        starknet_getEvents: (p) => {
          params = p
          return { result: { events: [] } }
        }
      }
    })
    return run((rpc) =>
      rpc.getEvents({ ...filter, keys: [["0xab"], []], chunkSize: 10 }).pipe(
        Effect.map(() =>
          expect(params).toStrictEqual({
            filter: {
              address: TOKEN,
              from_block: { block_number: 10 },
              to_block: { block_number: 20 },
              keys: [["0xab"], []],
              chunk_size: 10
            }
          })
        ),
        Effect.andThen(rpc.getEvents({ ...filter, keys: undefined })),
        // undefined is not JSON: the key is left out, the page size defaults to 1000
        Effect.map(() =>
          expect(params).toStrictEqual({
            filter: {
              address: TOKEN,
              from_block: { block_number: 10 },
              to_block: { block_number: 20 },
              chunk_size: 1000
            }
          })
        )
      )
    )
  })

  it.effect("returns a cursor tied to its endpoint and only asks that endpoint with it", () => {
    const tokens: Array<Schema.Json> = []
    const page = (p: Schema.Json) => {
      tokens.push(p)
      return { result: { events: [rawEvent()], continuation_token: "page-2" } }
    }
    const { calls, run } = setup({
      a: { starknet_blockNumber: () => new Response("down", { status: 503 }) },
      b: { starknet_blockNumber: head(20), starknet_getEvents: page }
    })
    return run((rpc) =>
      Effect.gen(function*() {
        const first = yield* rpc.getEvents(filter)
        assert.isDefined(first.cursor)
        expect(first.cursor).toStrictEqual({ endpoint: "b", cursor: "page-2" })
        calls.length = 0
        yield* rpc.getEvents({ ...filter, cursor: first.cursor })
        expect(calls).toStrictEqual(["b:starknet_getEvents"])
        expect(tokens[1]).toMatchObject({ filter: { continuation_token: "page-2" } })
      })
    )
  })

  it.effect("does not fall back from a failed cursor", () => {
    const invalid = () => ({ error: { code: 33, message: "invalid continuation token" } })
    const { calls, run } = setup({ a: { starknet_blockNumber: head(20), starknet_getEvents: invalid }, b: {} })
    const cursor = StarknetRpc.StarknetEventsCursor.make({ endpoint: "a", cursor: "x" })
    return run((rpc) => Effect.flip(rpc.getEvents({ ...filter, cursor }))).pipe(Effect.map((error) => {
      expect(error).toMatchObject({ reason: "Rejected", code: 33, endpoint: "a" })
      expect(calls.every((call) => call.startsWith("a:"))).toBe(true)
    }))
  })

  it.effect("fails a cursor from an unknown endpoint without a request", () => {
    const { calls, run } = setup({ a: {} })
    const cursor = StarknetRpc.StarknetEventsCursor.make({ endpoint: "gone", cursor: "x" })
    return run((rpc) => Effect.flip(rpc.getEvents({ ...filter, cursor }))).pipe(Effect.map((error) => {
      expect(error).toMatchObject({ reason: "Rejected", endpoint: "gone" })
      assert.instanceOf(error.cause, Error)
      expect(error.cause.message).toBe("no endpoint named gone")
      expect(calls).toStrictEqual([])
    }))
  })

  const failure = (reply: Node[string], options?: { readonly timeout?: Duration.Input }) =>
    setup({ a: { starknet_blockNumber: reply } }, options).run((rpc) => Effect.flip(rpc.blockNumber))

  it.effect("classifies HTTP 429 and 503 as Unavailable", () =>
    Effect.gen(function*() {
      for (const status of [429, 503]) {
        const error = yield* failure(() => new Response("busy", { status }))
        expect(error).toMatchObject({
          reason: "Unavailable",
          code: status,
          method: "starknet_blockNumber",
          endpoint: "a"
        })
      }
    }))

  // like fetch, hang until aborted
  const hang: Node[string] = (_, signal) =>
    new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason)))

  // live clock: the timeout and the retry backoff sleep for real
  it.live("classifies a timeout and a transport error as Unavailable", () =>
    Effect.gen(function*() {
      const timedOut = yield* failure(hang, { timeout: "20 millis" })
      expect(timedOut.reason).toBe("Unavailable")
      assert.instanceOf(timedOut.cause, Error)
      expect(timedOut.cause.message).toBe("timed out after 20ms")
      expect((yield* failure(() => Promise.reject(new TypeError("fetch failed")))).reason).toBe("Unavailable")
    }))

  it.effect("classifies JSON-RPC codes", () =>
    Effect.gen(function*() {
      const cases: Array<readonly [number, StarknetRpc.StarknetRpcErrorReason]> = [
        [63, "Unavailable"],
        [-32603, "Unavailable"],
        [24, "Lagging"],
        [29, "Lagging"],
        [31, "Rejected"],
        [34, "Rejected"],
        [-32602, "Rejected"]
      ]
      for (const [code, reason] of cases) {
        expect(yield* failure(() => ({ error: { code, message: "no" } }))).toMatchObject({ reason, code })
      }
    }))

  it.effect("classifies an invalid result or a non-JSON body as InvalidResponse", () =>
    Effect.gen(function*() {
      expect((yield* failure(() => ({ result: "twenty" }))).reason).toBe("InvalidResponse")
      expect((yield* failure(() => new Response("<html>"))).reason).toBe("InvalidResponse")
    }))

  // every message, stack and JSON along the cause chain, AggregateError members included
  const causeChain = (error: unknown): Array<string> =>
    error instanceof Error
      ? [
        error.message,
        String(error.stack),
        JSON.stringify(error),
        ...causeChain(error.cause),
        ...(error instanceof AggregateError ? error.errors.flatMap(causeChain) : [])
      ]
      : error === undefined
      ? []
      : [String(error)]

  it.effect("keeps the URL out of errors", () =>
    Effect.gen(function*() {
      for (
        const reply of [
          () => new Response("busy", { status: 503 }),
          () => ({ error: { code: 3, message: "no" } }),
          () => new Response("<html>"),
          () => Promise.reject(new TypeError("fetch failed: https://a.rpc.test/secret-key"))
        ]
      ) {
        const error = yield* failure(reply)
        assert.instanceOf(error.cause, Error)
        for (const text of causeChain(error)) expect(text).not.toContain("secret-key")
      }
    }))

  it.live("retries transient errors before falling back", () => {
    let attempts = 0
    const { calls, run } = setup({
      a: {
        starknet_blockNumber: () =>
          ++attempts === 2 ? { error: { code: 63, message: "unexpected" } } : new Response("busy", { status: 503 })
      },
      b: { starknet_blockNumber: head(7) }
    }, { retries: 2 })
    return run((rpc) => rpc.blockNumber).pipe(Effect.map((block) => {
      expect(block).toBe(BigInt(7))
      expect(calls).toStrictEqual([
        "a:starknet_chainId",
        "a:starknet_blockNumber",
        "a:starknet_blockNumber",
        "a:starknet_blockNumber",
        "b:starknet_chainId",
        "b:starknet_blockNumber"
      ])
    }))
  })

  it.live("does not retry a timeout and falls back", () => {
    let aborted = 0
    const { calls, run } = setup({
      a: {
        starknet_blockNumber: (params, signal) => {
          signal?.addEventListener("abort", () => aborted++)
          return hang(params, signal)
        }
      },
      b: { starknet_blockNumber: head(7) }
    }, { retries: 2, timeout: "20 millis" })
    return run((rpc) => rpc.blockNumber).pipe(Effect.map((block) => {
      expect(block).toBe(BigInt(7))
      expect(aborted).toBe(1)
      expect(calls).toStrictEqual([
        "a:starknet_chainId",
        "a:starknet_blockNumber",
        "b:starknet_chainId",
        "b:starknet_blockNumber"
      ])
    }))
  })

  // live clock: the default backoff from 500 millis sleeps for real
  it.live("uses the default retries and retry delay", () => {
    let attempts = 0
    const { calls, run } = setup({
      a: { starknet_blockNumber: () => ++attempts <= 2 ? new Response("down", { status: 503 }) : head(7)() }
    }, { defaults: true })
    return run((rpc) => rpc.blockNumber).pipe(Effect.map((block) => {
      expect(block).toBe(BigInt(7))
      expect(calls).toStrictEqual([
        "a:starknet_chainId",
        "a:starknet_blockNumber",
        "a:starknet_blockNumber",
        "a:starknet_blockNumber"
      ])
    }))
  })

  it.live("waits for Retry-After", () => {
    let attempts = 0
    const { calls, run } = setup({
      a: {
        starknet_blockNumber: () =>
          ++attempts === 1 ? new Response("slow down", { status: 429, headers: { "Retry-After": "1" } }) : head(5)()
      }
    }, { retries: 1 })
    return Effect.gen(function*() {
      const start = yield* Clock.currentTimeMillis
      expect(yield* run((rpc) => rpc.blockNumber)).toBe(BigInt(5))
      // retryDelay is 1 millis: only the header explains a one second wait
      expect((yield* Clock.currentTimeMillis) - start).toBeGreaterThanOrEqual(1000)
      expect(calls).toStrictEqual(["a:starknet_chainId", "a:starknet_blockNumber", "a:starknet_blockNumber"])
    })
  })

  it.effect("does not retry a 403 and falls back", () => {
    const { calls, run } = setup({
      a: { starknet_blockNumber: () => new Response("forbidden", { status: 403 }) },
      b: { starknet_blockNumber: head(7) }
    }, { retries: 3 })
    return run((rpc) => rpc.blockNumber).pipe(Effect.map((block) => {
      expect(block).toBe(BigInt(7))
      expect(calls).toStrictEqual([
        "a:starknet_chainId",
        "a:starknet_blockNumber",
        "b:starknet_chainId",
        "b:starknet_blockNumber"
      ])
    }))
  })

  it.effect("falls back after an invalid response and succeeds on the next endpoint", () => {
    const { calls, run } = setup({
      a: { starknet_blockNumber: () => ({ result: "twenty" }) },
      b: { starknet_blockNumber: head(7) }
    })
    return run((rpc) => rpc.blockNumber).pipe(Effect.map((block) => {
      expect(block).toBe(BigInt(7))
      expect(calls).toStrictEqual([
        "a:starknet_chainId",
        "a:starknet_blockNumber",
        "b:starknet_chainId",
        "b:starknet_blockNumber"
      ])
    }))
  })

  it.effect("runs one network check for concurrent first calls", () => {
    const { calls, run } = setup({ a: { starknet_blockNumber: head(1) } })
    return run((rpc) => Effect.all([rpc.blockNumber, rpc.blockNumber, rpc.blockNumber], { concurrency: "unbounded" }))
      .pipe(
        Effect.map(() =>
          expect(calls.filter((call) => call.endsWith("starknet_chainId"))).toStrictEqual(["a:starknet_chainId"])
        )
      )
  })

  it.effect("fails Rejected without a request when params do not encode", () => {
    const { calls, run } = setup({ a: { starknet_blockNumber: head(20) }, b: {} })
    return run((rpc) =>
      Effect.gen(function*() {
        // learn a's head first, so that getEvents has nothing to ask before encoding
        yield* rpc.blockNumber
        calls.length = 0
        const error = yield* Effect.flip(rpc.getEvents({ ...filter, keys: [["not a felt"]] }))
        expect(error).toMatchObject({ reason: "Rejected", method: "starknet_getEvents", endpoint: "a" })
        expect(calls).toStrictEqual([])
      })
    )
  })

  it.effect("records one span per request without the URL", () => {
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      }
    })
    const { calls, run } = setup({ a: { starknet_blockNumber: head(1) } })
    return run((rpc) => rpc.blockNumber).pipe(
      Effect.withTracer(tracer),
      Effect.map(() => {
        expect(calls).toStrictEqual(["a:starknet_chainId", "a:starknet_blockNumber"])
        expect(spans.map((span) => [span.name, Object.fromEntries(span.attributes)])).toStrictEqual([
          ["StarknetRpc.starknet_chainId", { network: "Starknet", endpoint: "a", method: "starknet_chainId" }],
          ["StarknetRpc.starknet_blockNumber", { network: "Starknet", endpoint: "a", method: "starknet_blockNumber" }]
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
      const fallback = setup({ a: { starknet_blockNumber: down }, b: { starknet_blockNumber: head(7) } })
      expect(yield* fallback.run((rpc) => rpc.blockNumber)).toBe(BigInt(7))
      expect(fallback.calls).toStrictEqual([
        "a:starknet_chainId",
        "a:starknet_blockNumber",
        "b:starknet_chainId",
        "b:starknet_blockNumber"
      ])

      const rejected = () => ({ error: { code: -32602, message: "invalid params" } })
      const stop = setup({ a: { starknet_blockNumber: rejected }, b: { starknet_blockNumber: head(7) } })
      expect((yield* stop.run((rpc) => Effect.flip(rpc.blockNumber))).reason).toBe("Rejected")
      expect(stop.calls).toStrictEqual(["a:starknet_chainId", "a:starknet_blockNumber"])
    }))

  it.effect("fails with the last error and keeps the others when every endpoint fails", () =>
    Effect.gen(function*() {
      const missing = () => ({ error: { code: 29, message: "transaction hash not found" } })
      const { run } = setup({
        a: { starknet_getTransactionReceipt: missing },
        b: { starknet_getTransactionReceipt: () => ({ result: { transaction_hash: TX, events: [] } }) }
      })
      const error = yield* run((rpc) => Effect.flip(rpc.getTransactionReceipt({ transactionHash: TX })))
      // b's receipt is pre-confirmed: no block
      expect(error).toMatchObject({ reason: "InvalidResponse", endpoint: "b" })
      assert.instanceOf(error.cause, AggregateError)
      expect(error.cause.errors).toMatchObject([{ endpoint: "a", reason: "Lagging", code: 29 }, { endpoint: "b" }])
    }))

  it.effect("checks the network once per endpoint and caches a mismatch", () =>
    Effect.gen(function*() {
      const ok = setup({ a: { starknet_blockNumber: head(1) } })
      yield* ok.run((rpc) => Effect.zip(rpc.blockNumber, rpc.blockNumber))
      expect(ok.calls.filter((call) => call.endsWith("starknet_chainId"))).toHaveLength(1)

      const sepolia = () => ({ result: "0x534e5f5345504f4c4941" })
      const wrong = setup({ a: { starknet_chainId: sepolia, starknet_blockNumber: head(1) }, b: {} })
      const errors = yield* wrong.run((rpc) => Effect.zip(Effect.flip(rpc.blockNumber), Effect.flip(rpc.blockNumber)))
      expect(errors.map((error) => error.reason)).toStrictEqual(["WrongNetwork", "WrongNetwork"])
      assert.instanceOf(errors[0].cause, Error)
      expect(errors[0].cause.message).toContain("got SN_SEPOLIA")
      expect(wrong.calls).toStrictEqual(["a:starknet_chainId"])
    }))

  it.effect("does not cache a failed network check", () => {
    let attempts = 0
    const { calls, run } = setup({
      a: {
        starknet_chainId: () => ++attempts === 1 ? new Response("down", { status: 503 }) : { result: SN_MAIN },
        starknet_blockNumber: head(1)
      }
    })
    return run((rpc) => Effect.zip(Effect.flip(rpc.blockNumber), rpc.blockNumber)).pipe(Effect.map(([error]) => {
      expect(error.reason).toBe("Unavailable")
      expect(calls).toStrictEqual(["a:starknet_chainId", "a:starknet_chainId", "a:starknet_blockNumber"])
    }))
  })

  it.effect("skips a lagging endpoint and remembers heads", () => {
    const events = () => ({ result: { events: [rawEvent()] } })
    const { calls, run } = setup({
      a: { starknet_blockNumber: head(15), starknet_getEvents: events },
      b: { starknet_blockNumber: head(30), starknet_getEvents: events }
    })
    return run((rpc) =>
      Effect.gen(function*() {
        expect((yield* rpc.getEvents(filter)).events).toHaveLength(1)
        expect(calls).toStrictEqual([
          "a:starknet_chainId",
          "a:starknet_blockNumber",
          "b:starknet_chainId",
          "b:starknet_blockNumber",
          "b:starknet_getEvents"
        ])
        calls.length = 0
        yield* rpc.getEvents({ ...filter, toBlock: BigInt(12) })
        // a's known head 15 covers block 12: no starknet_blockNumber
        expect(calls).toStrictEqual(["a:starknet_getEvents"])
      })
    )
  })

  it.effect("returns Lagging when no endpoint reached toBlock", () =>
    setup({ a: { starknet_blockNumber: head(15) } }).run((rpc) => Effect.flip(rpc.getEvents(filter))).pipe(
      Effect.map((error) => expect(error).toMatchObject({ reason: "Lagging", method: "starknet_getEvents" }))
    ))

  it.effect("rejects pre-confirmed, out-of-range and foreign events", () =>
    Effect.gen(function*() {
      for (
        const bad of [
          { block_number: null, block_hash: null },
          { block_hash: null },
          { block_number: 9 },
          { block_number: 21 },
          { from_address: OTHER }
        ]
      ) {
        const { run } = setup({
          a: { starknet_blockNumber: head(20), starknet_getEvents: () => ({ result: { events: [rawEvent(bad)] } }) }
        })
        expect((yield* run((rpc) => Effect.flip(rpc.getEvents(filter)))).reason, JSON.stringify(bad)).toBe(
          "InvalidResponse"
        )
      }
    }))

  it.effect("makes no call for an empty range", () => {
    const { calls, run } = setup({ a: {} })
    return run((rpc) => rpc.getEvents({ ...filter, fromBlock: BigInt(21) })).pipe(Effect.map((page) => {
      expect(page).toStrictEqual({ events: [], cursor: undefined })
      expect(calls).toStrictEqual([])
    }))
  })
})
