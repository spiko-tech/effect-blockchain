import * as JsonRpc from "@effect-blockchain/core/JsonRpc"
import { assert, describe, expect, it } from "@effect/vitest"
import * as Arr from "effect/Array"
import * as Clock from "effect/Clock"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as Tracer from "effect/Tracer"

// a minimal chain over the engine: its error, code table, network check and three methods
class FakeRpcError extends Schema.TaggedError<FakeRpcError>()("FakeRpcError", {
  reason: JsonRpc.Reason,
  method: Schema.String,
  endpoint: Schema.String,
  code: Schema.optional(Schema.Number),
  cause: Schema.Defect()
}) {}

const codes: ReadonlyMap<number, JsonRpc.Reason> = new Map([
  [-32005, "Unavailable"],
  [429, "Unavailable"],
  [24, "Lagging"],
  [-32001, "Pruned"]
])

const chainIdMethod = { name: "chainId", params: Schema.Undefined, result: Schema.String }
const blockNumberMethod = { name: "blockNumber", params: Schema.Tuple([]), result: Schema.Int }
const getRangeMethod = {
  name: "getRange",
  params: Schema.Tuple([Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))]),
  result: Schema.Array(Schema.Int)
}

type Body = { id: number; method: string; params?: Schema.Json }
type Reply = { readonly result: Schema.Json } | { readonly error: { code: number; message: string } } | Response
type Node = Record<
  string,
  (params: Schema.Json | undefined, signal: AbortSignal | null | undefined) => Reply | Promise<Reply>
>

const defaults: Node = { chainId: () => ({ result: "fake-1" }) }

// one fake fetch serving every endpoint, routed by host: `https://<name>.rpc.test/secret-key`
const setup = (
  nodes: Record<string, Node>,
  options: {
    readonly retries?: number
    readonly timeout?: Duration.Input
    readonly defaults?: boolean
    readonly parseBody?: (text: string) => Schema.Json | bigint
  } = {}
) => {
  const calls: Array<string> = []
  const bodies: Array<Body> = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const name = new URL(String(input)).hostname.split(".")[0]
    const body: Body = JSON.parse(await new Response(init?.body).text())
    calls.push(`${name}:${body.method}`)
    bodies.push(body)
    const handler = nodes[name]?.[body.method] ?? defaults[body.method]
    const reply = handler === undefined
      ? { error: { code: -32601, message: "method not found" } }
      : await handler(body.params, init?.signal)
    return reply instanceof Response ? reply : Response.json({ jsonrpc: "2.0", id: body.id, ...reply })
  }
  const names = Object.keys(nodes)
  if (!Arr.isReadonlyArrayNonEmpty(names)) throw new Error("setup needs at least one endpoint")
  const make = JsonRpc.make({
    spanPrefix: "FakeRpc",
    network: "Fakenet",
    endpoints: Arr.map(names, (name) => ({ name, url: Redacted.make(`https://${name}.rpc.test/secret-key`) })),
    // `defaults` leaves out `retries`, `retryDelay` and `timeout`
    ...(options.defaults ? {} : { retries: options.retries ?? 0, retryDelay: "1 millis", timeout: options.timeout }),
    codes,
    parseBody: options.parseBody,
    checkNetwork: (send, endpoint) =>
      send(chainIdMethod, undefined).pipe(
        Effect.filterOrFail((id) => id === "fake-1", (id) =>
          new FakeRpcError({
            reason: "WrongNetwork",
            method: chainIdMethod.name,
            endpoint,
            cause: new Error(`expected fake-1, got ${id}`)
          }))
      ),
    makeError: (fields: JsonRpc.ErrorFields) => new FakeRpcError(fields)
  })
  const run = <A, E>(
    f: (rpc: {
      readonly engine: Effect.Success<typeof make>
      readonly chainId: Effect.Effect<string, FakeRpcError>
      readonly blockNumber: Effect.Effect<number, FakeRpcError>
      readonly getRange: (toBlock: number) => Effect.Effect<ReadonlyArray<number>, FakeRpcError>
    }) => Effect.Effect<A, E>
  ) =>
    Effect.gen(function*() {
      const engine = yield* make
      return yield* f({
        engine,
        chainId: engine.withFallback(engine.checkNetwork),
        blockNumber: engine.withFallback((endpoint) => engine.call(endpoint, blockNumberMethod, [])),
        getRange: (toBlock) =>
          engine.withFallback((endpoint) =>
            engine.guard(
              endpoint,
              getRangeMethod.name,
              BigInt(toBlock),
              engine.call(endpoint, blockNumberMethod, []).pipe(Effect.map(BigInt))
            ).pipe(Effect.andThen(engine.call(endpoint, getRangeMethod, [toBlock])))
          )
      })
    }).pipe(Effect.provide(FetchHttpClient.layer), Effect.provideService(FetchHttpClient.Fetch, fetch))
  return { calls, bodies, run }
}

// every error under `error`: its `cause` chain and the errors of an `AggregateError`
const causeChain = (error: Error): Array<Error> => [
  error,
  ...(error instanceof AggregateError ? error.errors.filter((e) => e instanceof Error).flatMap(causeChain) : []),
  ...(error.cause instanceof Error ? causeChain(error.cause) : [])
]

const head = (block: number) => () => ({ result: block })

const failure = (reply: Node[string], options?: { readonly timeout?: Duration.Input }) =>
  setup({ a: { blockNumber: reply } }, options).run((rpc) => Effect.flip(rpc.blockNumber))

const down = () => new Response("down", { status: 503 })

// like fetch, hang until aborted
const hang: Node[string] = (_, signal) =>
  new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason)))

describe("JsonRpc", () => {
  it.effect("falls back in order, Rejected included", () =>
    Effect.gen(function*() {
      const fallback = setup({ a: { blockNumber: down }, b: { blockNumber: head(7) } })
      expect(yield* fallback.run((rpc) => rpc.blockNumber)).toBe(7)
      expect(fallback.calls).toStrictEqual(["a:chainId", "a:blockNumber", "b:chainId", "b:blockNumber"])

      const rejected = () => ({ error: { code: -32602, message: "invalid params" } })
      const rejected_ = setup({ a: { blockNumber: rejected }, b: { blockNumber: head(7) } })
      expect(yield* rejected_.run((rpc) => rpc.blockNumber)).toBe(7)
      expect(rejected_.calls).toStrictEqual(["a:chainId", "a:blockNumber", "b:chainId", "b:blockNumber"])
    }))

  it.effect("fails with the last error and keeps the others when every endpoint fails", () =>
    Effect.gen(function*() {
      const { run } = setup({ a: { blockNumber: down }, b: { blockNumber: () => ({ result: "nope" }) } })
      const error = yield* run((rpc) => Effect.flip(rpc.blockNumber))
      expect(error).toMatchObject({ reason: "InvalidResponse", endpoint: "b" })
      assert.instanceOf(error.cause, AggregateError)
      expect(error.cause.errors).toMatchObject([{ endpoint: "a", reason: "Unavailable", code: 503 }, { endpoint: "b" }])
    }))

  it.effect("falls back after an invalid response and succeeds on the next endpoint", () => {
    const { calls, run } = setup({ a: { blockNumber: () => ({ result: "nope" }) }, b: { blockNumber: head(7) } })
    return run((rpc) => rpc.blockNumber).pipe(Effect.map((block) => {
      expect(block).toBe(7)
      expect(calls).toStrictEqual(["a:chainId", "a:blockNumber", "b:chainId", "b:blockNumber"])
    }))
  })

  it.effect("checks the network once per endpoint and caches a mismatch", () =>
    Effect.gen(function*() {
      const ok = setup({ a: { blockNumber: head(1) } })
      yield* ok.run((rpc) => Effect.zip(rpc.blockNumber, rpc.blockNumber))
      expect(ok.calls.filter((call) => call.endsWith("chainId"))).toHaveLength(1)

      const wrong = setup({ a: { chainId: () => ({ result: "fake-2" }), blockNumber: head(1) }, b: {} })
      const errors = yield* wrong.run((rpc) => Effect.zip(Effect.flip(rpc.blockNumber), Effect.flip(rpc.blockNumber)))
      expect(errors.map((error) => error.reason)).toStrictEqual(["WrongNetwork", "WrongNetwork"])
      expect(wrong.calls).toStrictEqual(["a:chainId"])
    }))

  it.effect("does not cache a failed network check", () => {
    let attempts = 0
    const { calls, run } = setup({
      a: { chainId: () => ++attempts === 1 ? down() : { result: "fake-1" }, blockNumber: head(1) }
    })
    return run((rpc) => Effect.zip(Effect.flip(rpc.blockNumber), rpc.blockNumber)).pipe(Effect.map(([error]) => {
      expect(error.reason).toBe("Unavailable")
      expect(calls).toStrictEqual(["a:chainId", "a:chainId", "a:blockNumber"])
    }))
  })

  it.effect("runs one network check for concurrent first calls", () => {
    const { calls, run } = setup({ a: { blockNumber: head(1) } })
    return run((rpc) => Effect.all([rpc.blockNumber, rpc.blockNumber, rpc.chainId], { concurrency: "unbounded" })).pipe(
      Effect.map(([, , chainId]) => {
        expect(chainId).toBe("fake-1")
        expect(calls).toStrictEqual(["a:chainId", "a:blockNumber", "a:blockNumber"])
      })
    )
  })

  // live clock: the retry backoff sleeps for real
  it.live("retries transient errors before falling back", () => {
    let attempts = 0
    const { calls, run } = setup({
      a: { blockNumber: () => ++attempts % 2 === 1 ? down() : { error: { code: -32005, message: "limit exceeded" } } },
      b: { blockNumber: head(7) }
    }, { retries: 2 })
    return run((rpc) => rpc.blockNumber).pipe(Effect.map((block) => {
      expect(block).toBe(7)
      expect(calls).toStrictEqual([
        "a:chainId",
        "a:blockNumber",
        "a:blockNumber",
        "a:blockNumber",
        "b:chainId",
        "b:blockNumber"
      ])
    }))
  })

  it.live("does not retry a timeout and falls back", () => {
    let aborted = false
    const { calls, run } = setup({
      a: {
        blockNumber: (params, signal) => {
          signal?.addEventListener("abort", () => aborted = true)
          return hang(params, signal)
        }
      },
      b: { blockNumber: head(7) }
    }, { retries: 2, timeout: "20 millis" })
    return run((rpc) => rpc.blockNumber).pipe(Effect.map((block) => {
      expect(block).toBe(7)
      expect(aborted).toBe(true)
      expect(calls).toStrictEqual(["a:chainId", "a:blockNumber", "b:chainId", "b:blockNumber"])
    }))
  })

  it.live("uses the default retries and retry delay", () => {
    let attempts = 0
    const { calls, run } = setup({ a: { blockNumber: () => ++attempts <= 2 ? down() : head(7)() } }, {
      defaults: true
    })
    return run((rpc) => rpc.blockNumber).pipe(Effect.map((block) => {
      expect(block).toBe(7)
      expect(calls).toStrictEqual(["a:chainId", "a:blockNumber", "a:blockNumber", "a:blockNumber"])
    }))
  })

  it.live("waits for Retry-After", () => {
    let attempts = 0
    const { calls, run } = setup({
      a: {
        blockNumber: () =>
          ++attempts === 1 ? new Response("slow down", { status: 429, headers: { "Retry-After": "1" } }) : head(5)()
      }
    }, { retries: 1 })
    return Effect.gen(function*() {
      const start = yield* Clock.currentTimeMillis
      expect(yield* run((rpc) => rpc.blockNumber)).toBe(5)
      expect((yield* Clock.currentTimeMillis) - start).toBeGreaterThanOrEqual(1000)
      expect(calls).toStrictEqual(["a:chainId", "a:blockNumber", "a:blockNumber"])
    })
  })

  it.effect("does not retry a 403 and falls back", () => {
    const forbidden = () => new Response("forbidden", { status: 403 })
    const { calls, run } = setup({ a: { blockNumber: forbidden }, b: { blockNumber: forbidden } }, { retries: 3 })
    return run((rpc) => Effect.flip(rpc.blockNumber)).pipe(Effect.map((error) => {
      expect(error).toMatchObject({ reason: "Unavailable", code: 403, endpoint: "b" })
      expect(calls).toStrictEqual(["a:chainId", "a:blockNumber", "b:chainId", "b:blockNumber"])
    }))
  })

  it.effect("classifies HTTP 429 and 503 as Unavailable", () =>
    Effect.gen(function*() {
      for (const status of [429, 503]) {
        const error = yield* failure(() => new Response("busy", { status }))
        expect(error).toMatchObject({ reason: "Unavailable", code: status, method: "blockNumber", endpoint: "a" })
      }
    }))

  // live clock: the timeout sleeps for real
  it.live("classifies a timeout and a transport error as Unavailable", () =>
    Effect.gen(function*() {
      const timeout = yield* failure(hang, { timeout: "20 millis" })
      expect(timeout.reason).toBe("Unavailable")
      assert.instanceOf(timeout.cause, Error)
      expect(timeout.cause.message).toBe("timed out after 20ms")
      expect((yield* failure(() => Promise.reject(new TypeError("fetch failed")))).reason).toBe("Unavailable")
    }))

  it.effect("classifies JSON-RPC codes", () =>
    Effect.gen(function*() {
      const cases: Array<readonly [number, JsonRpc.Reason]> = [
        [-32005, "Unavailable"],
        [429, "Unavailable"],
        [24, "Lagging"],
        [-32001, "Pruned"],
        [-32602, "Rejected"],
        [3, "Rejected"]
      ]
      for (const [code, reason] of cases) {
        expect(yield* failure(() => ({ error: { code, message: "no" } }))).toMatchObject({ reason, code })
      }
    }))

  it.effect("classifies an invalid result or a non-JSON body as InvalidResponse", () =>
    Effect.gen(function*() {
      expect((yield* failure(() => ({ result: "twenty" }))).reason).toBe("InvalidResponse")
      expect((yield* failure(() => new Response("<html>"))).reason).toBe("InvalidResponse")
      expect((yield* failure(() => new Response(null))).reason).toBe("InvalidResponse")
    }))

  it.effect("fails Rejected without a request when params do not encode", () => {
    const { calls, run } = setup({ a: {} })
    return run((rpc) =>
      Effect.gen(function*() {
        yield* rpc.chainId
        calls.length = 0
        // a negative block is not a valid param
        const error = yield* Effect.flip(rpc.getRange(-1))
        expect(error).toMatchObject({ reason: "Rejected", method: "getRange", endpoint: "a" })
        expect(calls).toStrictEqual([])
      })
    )
  })

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
        for (const cause of causeChain(error.cause)) {
          expect(`${cause.message} ${cause.stack} ${JSON.stringify(cause)}`).not.toContain("secret-key")
        }
      }
    }))

  it.effect("records one span per request without the URL", () => {
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      }
    })
    const { run } = setup({ a: { blockNumber: head(1) } })
    return run((rpc) => rpc.blockNumber).pipe(
      Effect.withTracer(tracer),
      Effect.map(() => {
        expect(spans.map((span) => [span.name, Object.fromEntries(span.attributes)])).toStrictEqual([
          ["FakeRpc.chainId", { network: "Fakenet", endpoint: "a", method: "chainId" }],
          ["FakeRpc.blockNumber", { network: "Fakenet", endpoint: "a", method: "blockNumber" }]
        ])
        expect(JSON.stringify(spans.map((span) => [span.name, [...span.attributes]]))).not.toContain("secret-key")
      })
    )
  })

  it.effect("sends no params member when params encode to undefined", () => {
    const { bodies, run } = setup({ a: { blockNumber: head(1) } })
    return run((rpc) => rpc.blockNumber).pipe(Effect.map(() => {
      expect(bodies).toStrictEqual([
        { jsonrpc: "2.0", id: 1, method: "chainId" },
        { jsonrpc: "2.0", id: 1, method: "blockNumber", params: [] }
      ])
    }))
  })

  it.effect("reads the body with parseBody, bigint error codes included", () => {
    // every integer as a bigint, like Solana's u64-safe parse
    const parseBody = (text: string): Schema.Json | bigint =>
      JSON.parse(text, (_key, value) => Number.isInteger(value) ? BigInt(value) : value)
    const { calls, run } = setup({
      a: { blockNumber: () => ({ error: { code: -32005, message: "limit exceeded" } }) },
      b: { blockNumber: () => ({ error: { code: -32602, message: "invalid params" } }) }
    }, { parseBody })
    return run((rpc) => Effect.flip(rpc.blockNumber)).pipe(Effect.map((error) => {
      expect(error).toMatchObject({ reason: "Rejected", code: -32602, endpoint: "b" })
      assert.instanceOf(error.cause, AggregateError)
      expect(error.cause.errors).toMatchObject([{ reason: "Unavailable", code: -32005 }, { code: -32602 }])
      expect(calls).toStrictEqual(["a:chainId", "a:blockNumber", "b:chainId", "b:blockNumber"])
    }))
  })

  it.effect("skips a lagging endpoint and remembers heads", () => {
    const range = () => ({ result: [1] })
    const { calls, run } = setup({
      a: { blockNumber: head(15), getRange: range },
      b: { blockNumber: head(30), getRange: range }
    })
    return run((rpc) =>
      Effect.gen(function*() {
        expect(yield* rpc.getRange(20)).toStrictEqual([1])
        expect(calls).toStrictEqual(["a:chainId", "a:blockNumber", "b:chainId", "b:blockNumber", "b:getRange"])
        calls.length = 0
        yield* rpc.getRange(12)
        // a's known head 15 covers block 12: no blockNumber
        expect(calls).toStrictEqual(["a:getRange"])
      })
    )
  })

  it.effect("returns Lagging when no endpoint reached toBlock", () =>
    setup({ a: { blockNumber: head(15) } }).run((rpc) => Effect.flip(rpc.getRange(20))).pipe(
      Effect.map((error) => {
        expect(error).toMatchObject({ reason: "Lagging", method: "getRange", endpoint: "a" })
        assert.instanceOf(error.cause, Error)
        expect(error.cause.message).toBe("head 15 is below toBlock 20")
      })
    ))

  it.effect("finds a cursor's endpoint and fails an unknown one without a request", () => {
    const { calls, run } = setup({ a: {}, b: {} })
    return run((rpc) =>
      Effect.gen(function*() {
        expect((yield* rpc.engine.endpointOf("getRange", { endpoint: "b" })).name).toBe("b")
        const error = yield* Effect.flip(rpc.engine.endpointOf("getRange", { endpoint: "gone" }))
        expect(error).toMatchObject({ reason: "Rejected", method: "getRange", endpoint: "gone" })
        expect(calls).toStrictEqual([])
      })
    )
  })
})
