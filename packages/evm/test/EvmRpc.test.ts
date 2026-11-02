import { EvmAddress } from "@effect-blockchain/evm/EvmAddress"
import { EvmHexData } from "@effect-blockchain/evm/EvmHexData"
import { EvmLog } from "@effect-blockchain/evm/EvmLog"
import * as EvmRpc from "@effect-blockchain/evm/EvmRpc"
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
  (params: ReadonlyArray<Schema.Json>, signal: AbortSignal | null | undefined) => Reply | Promise<Reply>
>

const TOKEN = EvmAddress.make("0x1111111111111111111111111111111111111111")
const OTHER = EvmAddress.make("0x2222222222222222222222222222222222222222")

const baseLog = {
  address: TOKEN,
  topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"],
  data: "0x",
  blockNumber: "0xa",
  blockHash: "0x" + "ab".repeat(32),
  transactionHash: "0x" + "cd".repeat(32),
  transactionIndex: "0x0",
  logIndex: "0x0",
  removed: false
}

const rawLog = (overrides: { readonly [K in keyof typeof baseLog]?: Schema.Json } = {}) => ({
  ...baseLog,
  ...overrides
})

const defaults: Node = { eth_chainId: () => ({ result: "0x1" }) }

// one fake fetch serving every endpoint, routed by host: `https://<name>.rpc.test/secret-key`
const setup = (
  nodes: Record<string, Node>,
  options: { readonly retries?: number; readonly timeout?: Duration.Input } = {}
) => {
  const calls: Array<string> = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const name = new URL(String(input)).hostname.split(".")[0]
    const body: { id: number; method: string; params: ReadonlyArray<Schema.Json> } = JSON.parse(
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
  const layer = EvmRpc.layer({
    network: "Ethereum",
    endpoints: Arr.map(names, (name) => ({ name, url: Redacted.make(`https://${name}.rpc.test/secret-key`) })),
    retries: options.retries ?? 0,
    retryDelay: "1 millis",
    timeout: options.timeout
  }).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)))
  const run = <A, E>(f: (rpc: EvmRpc.EvmRpc["Service"]) => Effect.Effect<A, E>) =>
    Effect.gen(function*() {
      return yield* f(yield* EvmRpc.EvmRpc)
    }).pipe(Effect.provide(layer))
  return { calls, run }
}

// every error under `error`: its `cause` chain and the errors of an `AggregateError`
const causeChain = (error: Error): Array<Error> => [
  error,
  ...(error instanceof AggregateError ? error.errors.filter((e) => e instanceof Error).flatMap(causeChain) : []),
  ...(error.cause instanceof Error ? causeChain(error.cause) : [])
]

const filter = { address: TOKEN, fromBlock: BigInt(10), toBlock: BigInt(20) }
const head = (block: number) => () => ({ result: `0x${block.toString(16)}` })

describe("EvmLog", () => {
  it("decodes a raw JSON-RPC log, hex quantities included", () => {
    const log = Schema.decodeUnknownSync(EvmLog)(rawLog({ blockNumber: "0x1B4", logIndex: "0x10" }))
    expect(log.blockNumber).toBe(BigInt(436))
    expect(log.logIndex).toBe(16)
    expect(log.transactionIndex).toBe(0)
  })

  it("rejects a pending log and malformed quantities", () => {
    for (const overrides of [{ blockNumber: null }, { logIndex: "16" }, { blockNumber: "0x" }]) {
      expect(() => Schema.decodeUnknownSync(EvmLog)(rawLog(overrides))).toThrow()
    }
  })
})

describe("EvmRpc", () => {
  it.effect("decodes chainId, blockNumber and getLogs", () => {
    const { run } = setup({ a: { eth_blockNumber: head(20), eth_getLogs: () => ({ result: [rawLog()] }) } })
    return run((rpc) =>
      Effect.gen(function*() {
        expect(yield* rpc.chainId).toBe(1)
        expect(yield* rpc.blockNumber).toBe(BigInt(20))
        const logs = yield* rpc.getLogs(filter)
        expect(logs).toStrictEqual([Schema.decodeUnknownSync(EvmLog)(rawLog())])
      })
    )
  })

  it.effect("encodes getLogs params as hex quantities", () => {
    let params: ReadonlyArray<Schema.Json> = []
    const { run } = setup({
      a: {
        eth_blockNumber: head(20),
        eth_getLogs: (p) => {
          params = p
          return { result: [] }
        }
      }
    })
    return run((rpc) =>
      rpc.getLogs({ ...filter, address: [TOKEN, OTHER], topics: [null, [EvmHexData.make("0xab")]] }).pipe(
        Effect.map(() =>
          expect(params).toStrictEqual([{
            address: [TOKEN, OTHER],
            fromBlock: "0xa",
            toBlock: "0x14",
            topics: [null, ["0xab"]]
          }])
        ),
        Effect.andThen(rpc.getLogs({ ...filter, topics: undefined })),
        // undefined is not JSON: the key is left out
        Effect.map(() => expect(params).toStrictEqual([{ address: TOKEN, fromBlock: "0xa", toBlock: "0x14" }]))
      )
    )
  })

  const failure = (reply: Node[string], options?: { readonly timeout?: Duration.Input }) =>
    setup({ a: { eth_blockNumber: reply } }, options).run((rpc) => Effect.flip(rpc.blockNumber))

  const down = () => new Response("down", { status: 503 })

  it.effect("falls back in order and stops on Rejected", () =>
    Effect.gen(function*() {
      const fallback = setup({ a: { eth_blockNumber: down }, b: { eth_blockNumber: head(7) } })
      expect(yield* fallback.run((rpc) => rpc.blockNumber)).toBe(BigInt(7))
      expect(fallback.calls).toStrictEqual(["a:eth_chainId", "a:eth_blockNumber", "b:eth_chainId", "b:eth_blockNumber"])

      const rejected = () => ({ error: { code: -32602, message: "invalid params" } })
      const stop = setup({ a: { eth_blockNumber: rejected }, b: { eth_blockNumber: head(7) } })
      expect((yield* stop.run((rpc) => Effect.flip(rpc.blockNumber))).reason).toBe("Rejected")
      expect(stop.calls).toStrictEqual(["a:eth_chainId", "a:eth_blockNumber"])
    }))

  it.effect("fails with the last error and keeps the others when every endpoint fails", () =>
    Effect.gen(function*() {
      const { run } = setup({
        a: { eth_blockNumber: down },
        b: { eth_blockNumber: () => ({ result: "nope" }) }
      })
      const error = yield* run((rpc) => Effect.flip(rpc.blockNumber))
      expect(error).toMatchObject({ reason: "InvalidResponse", endpoint: "b" })
      assert.instanceOf(error.cause, AggregateError)
      expect(error.cause.errors).toMatchObject([{ endpoint: "a", reason: "Unavailable", code: 503 }, { endpoint: "b" }])
    }))

  it.effect("falls back after an invalid response and succeeds on the next endpoint", () => {
    const { calls, run } = setup({
      a: { eth_blockNumber: () => ({ result: "nope" }) },
      b: { eth_blockNumber: head(7) }
    })
    return run((rpc) => rpc.blockNumber).pipe(Effect.map((block) => {
      expect(block).toBe(BigInt(7))
      expect(calls).toStrictEqual(["a:eth_chainId", "a:eth_blockNumber", "b:eth_chainId", "b:eth_blockNumber"])
    }))
  })

  it.effect("checks the network once per endpoint and caches a mismatch", () =>
    Effect.gen(function*() {
      const ok = setup({ a: { eth_blockNumber: head(1) } })
      yield* ok.run((rpc) => Effect.zip(rpc.blockNumber, rpc.blockNumber))
      expect(ok.calls.filter((call) => call.endsWith("eth_chainId"))).toHaveLength(1)

      const wrong = setup({ a: { eth_chainId: () => ({ result: "0x89" }), eth_blockNumber: head(1) }, b: {} })
      const errors = yield* wrong.run((rpc) => Effect.zip(Effect.flip(rpc.blockNumber), Effect.flip(rpc.blockNumber)))
      expect(errors.map((error) => error.reason)).toStrictEqual(["WrongNetwork", "WrongNetwork"])
      expect(wrong.calls).toStrictEqual(["a:eth_chainId"])
    }))

  it.effect("does not cache a failed network check", () => {
    let attempts = 0
    const { calls, run } = setup({
      a: {
        eth_chainId: () => ++attempts === 1 ? new Response("down", { status: 503 }) : { result: "0x1" },
        eth_blockNumber: head(1)
      }
    })
    return run((rpc) => Effect.zip(Effect.flip(rpc.blockNumber), rpc.blockNumber)).pipe(Effect.map(([error]) => {
      expect(error.reason).toBe("Unavailable")
      expect(calls).toStrictEqual(["a:eth_chainId", "a:eth_chainId", "a:eth_blockNumber"])
    }))
  })

  it.effect("runs one network check for concurrent first calls", () => {
    const { calls, run } = setup({ a: { eth_blockNumber: head(1) } })
    return run((rpc) => Effect.all([rpc.blockNumber, rpc.blockNumber, rpc.chainId], { concurrency: "unbounded" })).pipe(
      Effect.map(() => {
        expect(calls).toStrictEqual(["a:eth_chainId", "a:eth_blockNumber", "a:eth_blockNumber"])
      })
    )
  })

  // live clock: the retry backoff sleeps for real
  it.live("retries transient errors before falling back", () => {
    let attempts = 0
    const { calls, run } = setup({
      a: {
        eth_blockNumber: () => ++attempts % 2 === 1 ? down() : { error: { code: -32005, message: "limit exceeded" } }
      },
      b: { eth_blockNumber: head(7) }
    }, { retries: 2 })
    return run((rpc) => rpc.blockNumber).pipe(Effect.map((block) => {
      expect(block).toBe(BigInt(7))
      expect(calls).toStrictEqual([
        "a:eth_chainId",
        "a:eth_blockNumber",
        "a:eth_blockNumber",
        "a:eth_blockNumber",
        "b:eth_chainId",
        "b:eth_blockNumber"
      ])
    }))
  })

  it.live("waits for Retry-After", () => {
    let attempts = 0
    const { calls, run } = setup({
      a: {
        eth_blockNumber: () =>
          ++attempts === 1 ? new Response("slow down", { status: 429, headers: { "Retry-After": "1" } }) : head(5)()
      }
    }, { retries: 1 })
    return Effect.gen(function*() {
      const start = yield* Clock.currentTimeMillis
      expect(yield* run((rpc) => rpc.blockNumber)).toBe(BigInt(5))
      expect((yield* Clock.currentTimeMillis) - start).toBeGreaterThanOrEqual(1000)
      expect(calls).toStrictEqual(["a:eth_chainId", "a:eth_blockNumber", "a:eth_blockNumber"])
    })
  })

  it.effect("does not retry a 403 and falls back", () => {
    const { calls, run } = setup({
      a: { eth_blockNumber: () => new Response("forbidden", { status: 403 }) },
      b: { eth_blockNumber: () => new Response("forbidden", { status: 403 }) }
    }, { retries: 3 })
    return run((rpc) => Effect.flip(rpc.blockNumber)).pipe(Effect.map((error) => {
      expect(error).toMatchObject({ reason: "Unavailable", code: 403, endpoint: "b" })
      expect(calls).toStrictEqual(["a:eth_chainId", "a:eth_blockNumber", "b:eth_chainId", "b:eth_blockNumber"])
    }))
  })

  it.effect("classifies HTTP 429 and 503 as Unavailable", () =>
    Effect.gen(function*() {
      for (const status of [429, 503]) {
        const error = yield* failure(() => new Response("busy", { status }))
        expect(error).toMatchObject({ reason: "Unavailable", code: status, method: "eth_blockNumber", endpoint: "a" })
      }
    }))

  // live clock: the timeout sleeps for real
  it.live("classifies a timeout and a transport error as Unavailable", () =>
    Effect.gen(function*() {
      // like fetch, hang until aborted
      const hang: Node[string] = (_, signal) =>
        new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason)))
      expect((yield* failure(hang, { timeout: "20 millis" })).reason).toBe("Unavailable")
      expect((yield* failure(() => Promise.reject(new TypeError("fetch failed")))).reason).toBe("Unavailable")
    }))

  it.effect("classifies JSON-RPC codes", () =>
    Effect.gen(function*() {
      const cases: Array<readonly [number, EvmRpc.EvmRpcErrorReason]> = [
        [-32005, "Unavailable"],
        [-32603, "Unavailable"],
        [-32007, "Unavailable"],
        [-1, "Unavailable"],
        [429, "Unavailable"],
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
        // a negative block is not a hex quantity
        const error = yield* Effect.flip(rpc.getLogs({ ...filter, fromBlock: BigInt(-2), toBlock: BigInt(-1) }))
        expect(error).toMatchObject({ reason: "Rejected", method: "eth_getLogs", endpoint: "a" })
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
    const { run } = setup({ a: { eth_blockNumber: head(1) } })
    return run((rpc) => rpc.blockNumber).pipe(
      Effect.withTracer(tracer),
      Effect.map(() => {
        expect(spans.map((span) => [span.name, Object.fromEntries(span.attributes)])).toStrictEqual([
          ["EvmRpc.eth_chainId", { network: "Ethereum", endpoint: "a", method: "eth_chainId" }],
          ["EvmRpc.eth_blockNumber", { network: "Ethereum", endpoint: "a", method: "eth_blockNumber" }]
        ])
        expect(JSON.stringify(spans.map((span) => [span.name, [...span.attributes]]))).not.toContain("secret-key")
      })
    )
  })

  it.effect("skips a lagging endpoint and remembers heads", () => {
    const logs = () => ({ result: [rawLog()] })
    const { calls, run } = setup({
      a: { eth_blockNumber: head(15), eth_getLogs: logs },
      b: { eth_blockNumber: head(30), eth_getLogs: logs }
    })
    return run((rpc) =>
      Effect.gen(function*() {
        expect(yield* rpc.getLogs(filter)).toHaveLength(1)
        expect(calls).toStrictEqual([
          "a:eth_chainId",
          "a:eth_blockNumber",
          "b:eth_chainId",
          "b:eth_blockNumber",
          "b:eth_getLogs"
        ])
        calls.length = 0
        yield* rpc.getLogs({ ...filter, toBlock: BigInt(12) })
        // a's known head 15 covers block 12: no eth_blockNumber
        expect(calls).toStrictEqual(["a:eth_getLogs"])
      })
    )
  })

  it.effect("returns Lagging when no endpoint reached toBlock", () =>
    setup({ a: { eth_blockNumber: head(15) } }).run((rpc) => Effect.flip(rpc.getLogs(filter))).pipe(
      Effect.map((error) => expect(error).toMatchObject({ reason: "Lagging", method: "eth_getLogs" }))
    ))

  it.effect("rejects removed, out-of-range, foreign and pending logs", () =>
    Effect.gen(function*() {
      for (
        const bad of [
          { removed: true },
          { blockNumber: "0x9" },
          { blockNumber: "0x15" },
          { address: OTHER },
          { blockHash: null, blockNumber: null }
        ]
      ) {
        const { run } = setup({ a: { eth_blockNumber: head(20), eth_getLogs: () => ({ result: [rawLog(bad)] }) } })
        expect((yield* run((rpc) => Effect.flip(rpc.getLogs(filter)))).reason, JSON.stringify(bad)).toBe(
          "InvalidResponse"
        )
      }
    }))

  it.effect("sorts logs by block then log index", () => {
    const { run } = setup({
      a: {
        eth_blockNumber: head(20),
        eth_getLogs: () => ({
          result: [
            rawLog({ blockNumber: "0xc", logIndex: "0x0" }),
            rawLog({ blockNumber: "0xb", logIndex: "0x2" }),
            rawLog({ blockNumber: "0xb", logIndex: "0x1" })
          ]
        })
      }
    })
    return run((rpc) => rpc.getLogs(filter)).pipe(
      Effect.map((logs) =>
        expect(logs.map((log) => [log.blockNumber, log.logIndex])).toStrictEqual([
          [BigInt(11), 1],
          [BigInt(11), 2],
          [BigInt(12), 0]
        ])
      )
    )
  })

  it.effect("makes no call for an empty range", () => {
    const { calls, run } = setup({ a: {} })
    return run((rpc) => rpc.getLogs({ ...filter, fromBlock: BigInt(21) })).pipe(Effect.map((logs) => {
      expect(logs).toStrictEqual([])
      expect(calls).toStrictEqual([])
    }))
  })
})
