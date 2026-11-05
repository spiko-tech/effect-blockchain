import type * as JsonRpc from "@effect-blockchain/core/JsonRpc"
import { StarknetAddress } from "@effect-blockchain/starknet/StarknetAddress"
import { StarknetEvent } from "@effect-blockchain/starknet/StarknetEvent"
import * as StarknetRpc from "@effect-blockchain/starknet/StarknetRpc"
import { StarknetTransactionHash } from "@effect-blockchain/starknet/StarknetTransactionHash"
import { assert, describe, expect, it } from "@effect/vitest"
import * as Arr from "effect/Array"
import * as Config from "effect/Config"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"

type Reply = { readonly result: Schema.Json } | { readonly error: { code: number; message: string } } | Response
type Node = Record<
  string,
  (params: Schema.Json) => Reply
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

// one fake fetch serving every endpoint, routed by host: `https://<name>.rpc.test/secret-key`, without retries
const setup = (nodes: Record<string, Node>) => {
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
      : handler(body.params)
    return reply instanceof Response ? reply : Response.json({ jsonrpc: "2.0", id: body.id, ...reply })
  }
  const names = Object.keys(nodes)
  if (!Arr.isReadonlyArrayNonEmpty(names)) throw new Error("setup needs at least one endpoint")
  const layer = StarknetRpc.layer({
    network: "Starknet",
    endpoints: Arr.map(names, (name) => ({ name, url: Redacted.make(`https://${name}.rpc.test/secret-key`) })),
    retries: 0
  }).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)))
  const run = <A, E>(f: (rpc: StarknetRpc.StarknetRpc["Service"]) => Effect.Effect<A, E>) =>
    Effect.gen(function*() {
      return yield* f(yield* StarknetRpc.StarknetRpc)
    }).pipe(Effect.provide(layer))
  return { calls, fetch, run }
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
      expect(error).toMatchObject({ reason: { _tag: "Rejected" }, code: 33, endpoint: "a" })
      expect(calls.every((call) => call.startsWith("a:"))).toBe(true)
    }))
  })

  it.effect("fails a cursor from an unknown endpoint without a request", () => {
    const { calls, run } = setup({ a: {} })
    const cursor = StarknetRpc.StarknetEventsCursor.make({ endpoint: "gone", cursor: "x" })
    return run((rpc) => Effect.flip(rpc.getEvents({ ...filter, cursor }))).pipe(Effect.map((error) => {
      expect(error).toMatchObject({ reason: { _tag: "Rejected" }, endpoint: "gone" })
      assert.instanceOf(error.cause, Error)
      expect(error.cause.message).toBe("no endpoint named gone")
      expect(calls).toStrictEqual([])
    }))
  })

  it.effect("maps the chain error codes to reasons", () =>
    Effect.gen(function*() {
      const cases: Array<readonly [number, JsonRpc.CodeReason]> = [
        [63, "Unavailable"],
        [-32603, "Unavailable"],
        [-32005, "Unavailable"],
        [429, "Unavailable"],
        [24, "Lagging"],
        [29, "Lagging"],
        [31, "Rejected"]
      ]
      for (const [code, reason] of cases) {
        const { run } = setup({ a: { starknet_blockNumber: () => ({ error: { code, message: "no" } }) } })
        const error = yield* run((rpc) => Effect.flip(rpc.blockNumber))
        expect(error).toMatchObject({ reason: { _tag: reason }, code, method: "starknet_blockNumber", endpoint: "a" })
        expect(error.message).toBe(`starknet_blockNumber failed on a: ${reason} (${code})`)
      }
    }))

  it.effect("fails WrongNetwork on a network mismatch", () => {
    const { calls, run } = setup({ a: { starknet_chainId: () => ({ result: "0x534e5f5345504f4c4941" }) }, b: {} })
    return run((rpc) => Effect.flip(rpc.chainId)).pipe(Effect.map((error) => {
      expect(error).toMatchObject({
        reason: { _tag: "WrongNetwork", expected: "SN_MAIN", actual: "SN_SEPOLIA" },
        method: "starknet_chainId",
        endpoint: "a"
      })
      expect(error.message).toBe("starknet_chainId failed on a: WrongNetwork")
      assert.instanceOf(error.cause, Error)
      expect(error.cause.message).toBe("expected chain ID SN_MAIN for Starknet, got SN_SEPOLIA")
      expect(calls).toStrictEqual(["a:starknet_chainId"])
    }))
  })

  it.effect("falls back to the next endpoint through the layer", () => {
    const { calls, run } = setup({
      a: { starknet_blockNumber: () => new Response("down", { status: 503 }) },
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
      Effect.map((error) => expect(error).toMatchObject({ reason: { _tag: "Lagging" }, method: "starknet_getEvents" }))
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
        expect((yield* run((rpc) => Effect.flip(rpc.getEvents(filter)))).reason._tag, JSON.stringify(bad)).toBe(
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

describe("layerConfig", () => {
  const endpoints = Config.all([Config.all({ name: Config.succeed("a"), url: Config.Redacted("STARKNET_RPC_URL") })])
  const run = (env: Record<string, string>) => {
    const { calls, fetch } = setup({ a: { starknet_blockNumber: head(20) } })
    const layer = StarknetRpc.layerConfig({
      network: Config.succeed("Starknet"),
      endpoints,
      retries: Config.succeed(0)
    }).pipe(
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env)))
    )
    return {
      calls,
      effect: Effect.gen(function*() {
        return yield* (yield* StarknetRpc.StarknetRpc).blockNumber
      }).pipe(Effect.provide(layer))
    }
  }

  it.effect("builds from config", () =>
    Effect.gen(function*() {
      const { calls, effect } = run({ STARKNET_RPC_URL: "https://a.rpc.test/secret-key" })
      expect(yield* effect).toStrictEqual(BigInt(20))
      expect(calls.length).toBeGreaterThan(0)
    }))

  it.effect("fails with a ConfigError when a value is missing", () =>
    Effect.gen(function*() {
      const { calls, effect } = run({})
      expect(yield* Effect.flip(effect)).toMatchObject({ _tag: "ConfigError" })
      expect(calls).toStrictEqual([])
    }))

  it("keeps the endpoint url redacted", () => {
    StarknetRpc.layerConfig({
      network: Config.succeed("Starknet"),
      // @ts-expect-error a plain string url is rejected
      endpoints: Config.all([Config.all({ name: Config.succeed("a"), url: Config.String("STARKNET_RPC_URL") })])
    })
  })
})
