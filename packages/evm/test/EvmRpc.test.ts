import { EvmAddress } from "@effect-blockchain/evm/EvmAddress"
import { EvmHexData } from "@effect-blockchain/evm/EvmHexData"
import { EvmLog } from "@effect-blockchain/evm/EvmLog"
import * as EvmRpc from "@effect-blockchain/evm/EvmRpc"
import { describe, expect, it } from "@effect/vitest"
import type * as Arr from "effect/Array"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"

type Reply = { readonly result: unknown } | { readonly error: { code: number; message: string } } | Response
type Node = Record<string, (params: ReadonlyArray<unknown>, signal: AbortSignal) => Reply | Promise<Reply>>

const TOKEN = EvmAddress.make("0x1111111111111111111111111111111111111111")
const OTHER = EvmAddress.make("0x2222222222222222222222222222222222222222")

const rawLog = (overrides: Record<string, unknown> = {}) => ({
  address: TOKEN,
  topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"],
  data: "0x",
  blockNumber: "0xa",
  blockHash: "0x" + "ab".repeat(32),
  transactionHash: "0x" + "cd".repeat(32),
  transactionIndex: "0x0",
  logIndex: "0x0",
  removed: false,
  ...overrides
})

// one fake fetch serving every endpoint, routed by host: `https://<name>.rpc.test/secret-key`
const setup = (
  nodes: Record<string, Node>,
  options: { readonly retries?: number; readonly timeout?: Duration.Input } = {}
) => {
  const calls: Array<string> = []
  const fetch = (async (url: string, init: RequestInit) => {
    const name = new URL(url).hostname.split(".")[0]
    const body = JSON.parse(String(init.body))
    calls.push(`${name}:${body.method}`)
    const handler = nodes[name][body.method] ?? (body.method === "eth_chainId" ? () => ({ result: "0x1" }) : undefined)
    const reply = await handler(body.params, init.signal!)
    return reply instanceof Response ? reply : Response.json({ jsonrpc: "2.0", id: body.id, ...reply })
  }) as unknown as typeof globalThis.fetch
  const layer = EvmRpc.layer({
    network: "Ethereum",
    endpoints: Object.keys(nodes).map((name) => ({
      name,
      url: Redacted.make(`https://${name}.rpc.test/secret-key`)
    })) as unknown as Arr.NonEmptyReadonlyArray<EvmRpc.EvmRpcEndpoint>,
    retries: options.retries ?? 0,
    retryDelay: "1 millis",
    timeout: options.timeout,
    fetch
  })
  const run = <A, E>(f: (rpc: EvmRpc.EvmRpc["Service"]) => Effect.Effect<A, E>) =>
    Effect.gen(function*() {
      return yield* f(yield* EvmRpc.EvmRpc)
    }).pipe(Effect.provide(layer))
  return { calls, run }
}

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
    let params: unknown
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
        )
      )
    )
  })

  const failure = (reply: Node[string], options?: { readonly timeout?: Duration.Input }) =>
    setup({ a: { eth_blockNumber: reply } }, options).run((rpc) => Effect.flip(rpc.blockNumber))

  it.effect("classifies HTTP 429 and 503 as Unavailable", () =>
    Effect.gen(function*() {
      for (const status of [429, 503]) {
        const error = yield* failure(() => new Response("busy", { status }))
        expect(error).toMatchObject({ reason: "Unavailable", code: status, method: "eth_blockNumber", endpoint: "a" })
      }
    }))

  it.effect("classifies a timeout as Unavailable", () =>
    Effect.gen(function*() {
      // like fetch, hang until aborted
      const hang = (_: unknown, signal: AbortSignal) =>
        new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)))
      const error = yield* failure(hang, { timeout: "20 millis" })
      expect(error.reason).toBe("Unavailable")
    }))

  it.effect("classifies JSON-RPC codes", () =>
    Effect.gen(function*() {
      const rejected = yield* failure(() => ({ error: { code: -32602, message: "invalid params" } }))
      expect(rejected).toMatchObject({ reason: "Rejected", code: -32602 })
      const limited = yield* failure(() => ({ error: { code: -32005, message: "limit exceeded" } }))
      expect(limited).toMatchObject({ reason: "Unavailable", code: -32005 })
    }))

  it.effect("classifies an invalid result as InvalidResponse", () =>
    Effect.gen(function*() {
      expect((yield* failure(() => ({ result: "twenty" }))).reason).toBe("InvalidResponse")
    }))

  it.effect("keeps the URL out of errors", () =>
    Effect.gen(function*() {
      for (
        const reply of [() => new Response("busy", { status: 503 }), () => ({ error: { code: 3, message: "no" } })]
      ) {
        const error = yield* failure(reply)
        const cause = error.cause as Error
        expect(`${cause.message} ${cause.stack} ${JSON.stringify(cause)}`).not.toContain("secret-key")
        expect(cause.message).toContain("https://a.rpc.test/[REDACTED]")
      }
    }))

  it.effect("lets viem retry before falling back", () => {
    let attempts = 0
    const { calls, run } = setup({
      a: { eth_blockNumber: () => ++attempts < 3 ? new Response("busy", { status: 503 }) : { result: "0x5" } }
    }, { retries: 2 })
    return run((rpc) => rpc.blockNumber).pipe(Effect.map((block) => {
      expect(block).toBe(BigInt(5))
      expect(calls).toStrictEqual(["a:eth_chainId", "a:eth_blockNumber", "a:eth_blockNumber", "a:eth_blockNumber"])
    }))
  })

  it.effect("falls back in order and stops on Rejected", () =>
    Effect.gen(function*() {
      const down = () => new Response("down", { status: 503 })
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
        a: { eth_blockNumber: () => new Response("down", { status: 503 }) },
        b: { eth_blockNumber: () => ({ result: "nope" }) }
      })
      const error = yield* run((rpc) => Effect.flip(rpc.blockNumber))
      expect(error).toMatchObject({ reason: "InvalidResponse", endpoint: "b" })
      expect((error.cause as AggregateError).errors.map((e: EvmRpc.EvmRpcError) => e.endpoint)).toStrictEqual([
        "a",
        "b"
      ])
    }))

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
