import type * as JsonRpc from "@effect-blockchain/core/JsonRpc"
import { EvmAddress } from "@effect-blockchain/evm/EvmAddress"
import { EvmHexData } from "@effect-blockchain/evm/EvmHexData"
import { EvmLog } from "@effect-blockchain/evm/EvmLog"
import * as EvmNetwork from "@effect-blockchain/evm/EvmNetwork"
import * as EvmRpc from "@effect-blockchain/evm/EvmRpc"
import { describe, expect, it } from "@effect/vitest"
import * as Arr from "effect/Array"
import * as Config from "effect/Config"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"

type Reply = { readonly result: Schema.Json } | { readonly error: { code: number; message: string } } | Response
type Node = Record<string, (params: ReadonlyArray<Schema.Json>) => Reply>

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
// no retries: a 503 falls back at once
const setup = (nodes: Record<string, Node>) => {
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
      : handler(body.params)
    return reply instanceof Response ? reply : Response.json({ jsonrpc: "2.0", id: body.id, ...reply })
  }
  const names = Object.keys(nodes)
  if (!Arr.isReadonlyArrayNonEmpty(names)) throw new Error("setup needs at least one endpoint")
  const layer = EvmRpc.layer({
    network: "Ethereum",
    endpoints: Arr.map(names, (name) => ({ name, url: Redacted.make(`https://${name}.rpc.test/secret-key`) })),
    retries: 0,
    retryDelay: "1 millis"
  }).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)))
  const run = <A, E>(f: (rpc: EvmRpc.EvmRpc["Service"]) => Effect.Effect<A, E>) =>
    Effect.gen(function*() {
      return yield* f(yield* EvmRpc.EvmRpc)
    }).pipe(Effect.provide(layer))
  return { calls, fetch, run }
}

const filter: EvmRpc.EvmLogsFilter = { addresses: [TOKEN], fromBlock: BigInt(10), toBlock: BigInt(20) }
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
        expect(yield* rpc.chainId).toBe(EvmNetwork.toChainId("Ethereum"))
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
      rpc.getLogs({ ...filter, addresses: [TOKEN, OTHER], topics: [null, [EvmHexData.make("0xab")]] }).pipe(
        Effect.map(() =>
          expect(params).toStrictEqual([{
            address: [TOKEN, OTHER],
            fromBlock: "0xa",
            toBlock: "0x14",
            topics: [null, ["0xab"]]
          }])
        ),
        Effect.andThen(rpc.getLogs({ ...filter, topics: undefined })),
        // undefined is not JSON: the key is left out, and a single address is still sent as an array
        Effect.map(() => expect(params).toStrictEqual([{ address: [TOKEN], fromBlock: "0xa", toBlock: "0x14" }]))
      )
    )
  })

  it.effect("maps the chain error codes to reasons", () =>
    Effect.gen(function*() {
      const cases: Array<readonly [number, JsonRpc.CodeReason]> = [
        [-32005, "Unavailable"],
        [-32603, "Unavailable"],
        [-32007, "Unavailable"],
        [-1, "Unavailable"],
        [429, "Unavailable"],
        [-32602, "Rejected"]
      ]
      for (const [code, reason] of cases) {
        const { run } = setup({ a: { eth_blockNumber: () => ({ error: { code, message: "no" } }) } })
        expect(yield* run((rpc) => Effect.flip(rpc.blockNumber))).toMatchObject({ reason: { _tag: reason }, code })
      }
    }))

  it.effect("matches a reason with catchReason", () => {
    const { run } = setup({ a: { eth_chainId: () => ({ result: "0x89" }) } })
    return run((rpc) =>
      rpc.chainId.pipe(
        Effect.map(String),
        Effect.catchReason("EvmRpcError", "WrongNetwork", (reason) => Effect.succeed(reason.actual))
      )
    ).pipe(Effect.map((actual) => expect(actual).toBe("137")))
  })

  it.effect("fails WrongNetwork on a network mismatch", () => {
    const { calls, run } = setup({ a: { eth_chainId: () => ({ result: "0x89" }) } })
    return run((rpc) => Effect.flip(rpc.chainId)).pipe(Effect.map((error) => {
      expect(error).toMatchObject({
        reason: { _tag: "WrongNetwork", expected: "1", actual: "137" },
        method: "eth_chainId",
        endpoint: "a"
      })
      expect(error.message).toBe("eth_chainId failed on a: WrongNetwork")
      expect(calls).toStrictEqual(["a:eth_chainId"])
    }))
  })

  it.effect("falls back to the next endpoint through the layer", () => {
    const { calls, run } = setup({
      a: { eth_blockNumber: () => new Response("down", { status: 503 }) },
      b: { eth_blockNumber: head(7) }
    })
    return run((rpc) => rpc.blockNumber).pipe(Effect.map((block) => {
      expect(block).toBe(BigInt(7))
      expect(calls).toStrictEqual(["a:eth_chainId", "a:eth_blockNumber", "b:eth_chainId", "b:eth_blockNumber"])
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
      Effect.map((error) => expect(error).toMatchObject({ reason: { _tag: "Lagging" }, method: "eth_getLogs" }))
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
        expect((yield* run((rpc) => Effect.flip(rpc.getLogs(filter)))).reason._tag, JSON.stringify(bad)).toBe(
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

describe("layerConfig", () => {
  const endpoints = Config.all([Config.all({ name: Config.succeed("a"), url: Config.Redacted("ETHEREUM_RPC_URL") })])
  const run = (env: Record<string, string>) => {
    const { calls, fetch } = setup({ a: { eth_blockNumber: head(42) } })
    const layer = EvmRpc.layerConfig({ network: Config.succeed("Ethereum"), endpoints, retries: Config.succeed(0) })
      .pipe(
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env)))
      )
    return {
      calls,
      effect: Effect.gen(function*() {
        return yield* (yield* EvmRpc.EvmRpc).blockNumber
      }).pipe(Effect.provide(layer))
    }
  }

  it.effect("builds from config", () =>
    Effect.gen(function*() {
      const { calls, effect } = run({ ETHEREUM_RPC_URL: "https://a.rpc.test/secret-key" })
      expect(yield* effect).toStrictEqual(BigInt(42))
      expect(calls.length).toBeGreaterThan(0)
    }))

  it.effect("fails with a ConfigError when a value is missing", () =>
    Effect.gen(function*() {
      const { calls, effect } = run({})
      expect(yield* Effect.flip(effect)).toMatchObject({ _tag: "ConfigError" })
      expect(calls).toStrictEqual([])
    }))

  it("keeps the endpoint url redacted", () => {
    EvmRpc.layerConfig({
      network: Config.succeed("Ethereum"),
      // @ts-expect-error a plain string url is rejected
      endpoints: Config.all([Config.all({ name: Config.succeed("a"), url: Config.String("ETHEREUM_RPC_URL") })])
    })
  })
})
