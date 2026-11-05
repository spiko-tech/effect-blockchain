import * as JsonRpc from "@effect-blockchain/core/JsonRpc"
import * as Replay from "@effect-blockchain/core/test/utils/replay"
import { EvmAddress } from "@effect-blockchain/evm/EvmAddress"
import { EvmHexData } from "@effect-blockchain/evm/EvmHexData"
import * as EvmIndexer from "@effect-blockchain/evm/EvmIndexer"
import { EvmLog } from "@effect-blockchain/evm/EvmLog"
import * as EvmNetwork from "@effect-blockchain/evm/EvmNetwork"
import * as EvmRpc from "@effect-blockchain/evm/EvmRpc"
import { describe, expect, it } from "@effect/vitest"
import type * as Arr from "effect/Array"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Result from "effect/Result"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as TestClock from "effect/testing/TestClock"

const fixtures = new URL("fixtures/", import.meta.url)

const EUTBL = EvmAddress.make("0xa0769f7a8fc65e47de93797b4e21c073c117fc80")
const USTBL = EvmAddress.make("0xe4880249745eac5f1ed9d8f7df844792d560e750")
const TRANSFER = EvmHexData.make("0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef")
// the pinned inputs of `scripts/record-fixtures.ts`
const FROM = BigInt(26083549)
const TO = BigInt(26083558)
const filter: EvmRpc.EvmLogsFilter = { addresses: [EUTBL, USTBL], fromBlock: FROM, toBlock: TO, topics: [TRANSFER] }

const RpcRequest = Schema.Struct({ id: Schema.Number, method: Schema.String, params: Schema.Json })
const RangeParams = Schema.Tuple([Schema.Struct({ fromBlock: Schema.String, toBlock: Schema.String })])
const LogsBody = Schema.fromJsonString(
  Schema.Struct({ result: Schema.Array(Schema.Record(Schema.String, Schema.Json)) })
)

const provide = <A, E>(
  effect: Effect.Effect<A, E, EvmIndexer.EvmIndexer>,
  rpc: Layer.Layer<EvmRpc.EvmRpc>,
  options?: Parameters<typeof EvmIndexer.layer>[0]
) => effect.pipe(Effect.provide(EvmIndexer.layer(options).pipe(Layer.provide(rpc))))

const rpcLayer = (
  endpoints: Arr.NonEmptyReadonlyArray<{ readonly name: string; readonly url: Redacted.Redacted<string> }>,
  fetch: typeof globalThis.fetch
) =>
  EvmRpc.layer({ network: "Ethereum", endpoints, retries: 0, retryDelay: "1 millis" }).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))
  )

// One endpoint answering `eth_chainId` and `eth_blockNumber` from a provider's recorded replies, and each
// `eth_getLogs` chunk with the recorded logs of the pinned range that fall in the chunk. `ranges` lists the requested
// chunks as `[fromBlock, toBlock]`. A `getLogs` reply in `failAt` is an HTTP 503 instead.
const chunked = (provider: string, options: { readonly head?: string; readonly failAt?: number } = {}) => {
  const recorded = Schema.decodeUnknownSync(LogsBody)(Replay.load(fixtures, provider, "getLogs").body).result
  const ranges: Array<readonly [bigint, bigint]> = []
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    const { id, method, params } = Schema.decodeUnknownSync(Schema.fromJsonString(RpcRequest))(
      await new Response(init?.body).text()
    )
    if (method !== "eth_getLogs") {
      const name = method === "eth_chainId" ? "chainId" : "blockNumber"
      return options.head !== undefined && name === "blockNumber"
        ? Response.json({ jsonrpc: "2.0", id, result: options.head })
        : new Response(Replay.load(fixtures, provider, name).body)
    }
    const [{ fromBlock, toBlock }] = Schema.decodeUnknownSync(RangeParams)(params)
    ranges.push([BigInt(fromBlock), BigInt(toBlock)])
    if (ranges.length === options.failAt) return new Response("down", { status: 503 })
    const result = recorded.filter((log) =>
      BigInt(String(log.blockNumber)) >= BigInt(fromBlock) && BigInt(String(log.blockNumber)) <= BigInt(toBlock)
    )
    return Response.json({ jsonrpc: "2.0", id, result })
  }
  const layer = rpcLayer([{ name: provider, url: Redacted.make(`https://${provider}.fixture`) }], fetch)
  return { layer, ranges }
}

const expectPinnedLogs = (logs: ReadonlyArray<{ readonly address: string; readonly blockNumber: bigint }>) => {
  expect(logs.map((log) => [log.address, log.blockNumber])).toStrictEqual([
    [USTBL, FROM],
    [USTBL, FROM + BigInt(2)],
    [USTBL, TO - BigInt(1)],
    [USTBL, TO],
    [EUTBL, TO]
  ])
}

const fetchPinned = Effect.gen(function*() {
  return yield* (yield* EvmIndexer.EvmIndexer).fetchLogs(filter)
})

const lastConfirmedBlock = Effect.gen(function*() {
  return yield* (yield* EvmIndexer.EvmIndexer).lastConfirmedBlock
})

describe("EvmIndexer", () => {
  for (const provider of ["alchemy", "infura"]) {
    // the recorded request covers the whole pinned range: the default maxBlockRange sends it as one chunk
    it.effect(`fixture: ${provider} getLogs in one chunk`, () => {
      const { check, endpoints, fetch, served } = Replay.replay(fixtures, [
        { name: provider, cases: ["chainId", "blockNumber", "getLogs"] }
      ])
      return check(provide(fetchPinned, rpcLayer(endpoints, fetch))).pipe(Effect.map((logs) => {
        expectPinnedLogs(logs)
        expect(served).toStrictEqual([`${provider} chainId`, `${provider} blockNumber`, `${provider} getLogs`])
      }))
    })

    // no recording per chunk: each chunk is answered with the recorded logs inside it
    it.effect(`fixture: ${provider} getLogs split into chunks`, () => {
      const { layer, ranges } = chunked(provider)
      return provide(fetchPinned, layer, { maxBlockRange: 3 }).pipe(Effect.map((logs) => {
        expectPinnedLogs(logs)
        expect(ranges).toStrictEqual([
          [FROM, FROM + BigInt(2)],
          [FROM + BigInt(3), FROM + BigInt(5)],
          [FROM + BigInt(6), FROM + BigInt(8)],
          [TO, TO]
        ])
      }))
    })
  }

  it.effect("chunks a range that is an exact multiple of maxBlockRange", () => {
    const { layer, ranges } = chunked("alchemy")
    return provide(fetchPinned, layer, { maxBlockRange: 5 }).pipe(Effect.map((logs) => {
      expectPinnedLogs(logs)
      expect(ranges).toStrictEqual([[FROM, FROM + BigInt(4)], [FROM + BigInt(5), TO]])
    }))
  })

  it.effect("sends one block per chunk with maxBlockRange 1", () => {
    const { layer, ranges } = chunked("alchemy")
    return provide(fetchPinned, layer, { maxBlockRange: 1 }).pipe(Effect.map((logs) => {
      expectPinnedLogs(logs)
      expect(ranges).toHaveLength(10)
      expect(ranges.every(([from, to]) => from === to)).toBe(true)
    }))
  })

  it.effect("fetches a single block range", () => {
    const { layer, ranges } = chunked("alchemy")
    const effect = Effect.gen(function*() {
      return yield* (yield* EvmIndexer.EvmIndexer).fetchLogs({ ...filter, fromBlock: TO })
    })
    return provide(effect, layer).pipe(Effect.map((logs) => {
      expect(logs.map((log) => log.address)).toStrictEqual([USTBL, EUTBL])
      expect(ranges).toStrictEqual([[TO, TO]])
    }))
  })

  it.effect("returns [] without a call when fromBlock > toBlock", () => {
    const { layer, ranges } = chunked("alchemy")
    const effect = Effect.gen(function*() {
      return yield* (yield* EvmIndexer.EvmIndexer).fetchLogs({ ...filter, fromBlock: TO + BigInt(1) })
    })
    return provide(effect, layer).pipe(Effect.map((logs) => {
      expect(logs).toStrictEqual([])
      expect(ranges).toStrictEqual([])
    }))
  })

  it.effect("fails with the first failing chunk's error and sends no further chunk", () => {
    const { layer, ranges } = chunked("alchemy", { failAt: 2 })
    return provide(Effect.flip(fetchPinned), layer, { maxBlockRange: 3 }).pipe(Effect.map((error) => {
      expect(error).toMatchObject({
        _tag: "EvmRpcError",
        reason: { _tag: "Unavailable" },
        code: 503,
        method: "eth_getLogs"
      })
      expect(ranges).toHaveLength(2)
    }))
  })

  it.effect("lastConfirmedBlock subtracts the network's default confirmations", () =>
    provide(lastConfirmedBlock, chunked("alchemy", { head: "0x64" }).layer).pipe(
      Effect.map((block) => expect(block).toBe(BigInt(100 - EvmNetwork.defaultConfirmations("Ethereum"))))
    ))

  it.effect("lastConfirmedBlock subtracts the configured confirmations", () =>
    provide(lastConfirmedBlock, chunked("alchemy", { head: "0x64" }).layer, { confirmations: 10 }).pipe(
      Effect.map((block) => expect(block).toBe(BigInt(90)))
    ))

  it.effect("lastConfirmedBlock is 0 when the confirmations reach above the head", () =>
    Effect.gen(function*() {
      for (const confirmations of [100, 101]) {
        const block = yield* provide(lastConfirmedBlock, chunked("alchemy", { head: "0x64" }).layer, { confirmations })
        expect(block).toBe(BigInt(0))
      }
    }))

  it.effect("lastConfirmedBlock fails with the rpc error", () => {
    const fetch: typeof globalThis.fetch = async () => new Response("down", { status: 503 })
    const layer = rpcLayer([{ name: "a", url: Redacted.make("https://a.rpc.test") }], fetch)
    return provide(Effect.flip(lastConfirmedBlock), layer).pipe(
      Effect.map((error) => expect(error).toMatchObject({ reason: { _tag: "Unavailable" }, code: 503 }))
    )
  })

  it.effect("dies on a maxBlockRange that is not a positive integer", () =>
    Effect.gen(function*() {
      for (const maxBlockRange of [0, -1, 1.5]) {
        const exit = yield* Effect.exit(provide(fetchPinned, chunked("alchemy").layer, { maxBlockRange }))
        expect(Result.getOrUndefined(Exit.findDefect(exit))).toBeInstanceOf(RangeError)
      }
    }))
})

// The recorded logs of the pinned range, served by the fake `EvmRpc` below.
const pinnedLogs = Schema.decodeUnknownSync(Schema.Array(EvmLog))(
  Schema.decodeUnknownSync(LogsBody)(Replay.load(fixtures, "alchemy", "getLogs").body).result
)

// A fake `EvmRpc`: `eth_blockNumber` reads `state.head`, `eth_getLogs` answers the pinned logs inside the range and
// records it in `state.ranges`. The n-th `getLogs` call (1-based) fails with `failAt.get(n)` when set, the n-th
// `blockNumber` call with `headFailAt.get(n)`. A fake service rather than a fake endpoint: `Pruned` cannot come from
// an HTTP reply on EVM.
const fakeRpc = (
  head: bigint,
  failAt: ReadonlyMap<number, JsonRpc.Reason> = new Map(),
  headFailAt: ReadonlyMap<number, JsonRpc.Reason> = new Map()
) => {
  const state = { head, heads: 0, ranges: new Array<readonly [bigint, bigint]>() }
  const layer = Layer.succeed(
    EvmRpc.EvmRpc,
    EvmRpc.EvmRpc.of({
      network: "Ethereum",
      chainId: Effect.die("unused"),
      blockNumber: Effect.suspend(() => {
        const reason = headFailAt.get(++state.heads)
        return reason === undefined
          ? Effect.succeed(state.head)
          : Effect.fail(
            new EvmRpc.EvmRpcError({
              reason,
              method: "eth_blockNumber",
              endpoint: "fake",
              cause: new Error(reason._tag)
            })
          )
      }),
      getLogs: (filter) =>
        Effect.suspend(() => {
          state.ranges.push([filter.fromBlock, filter.toBlock])
          const reason = failAt.get(state.ranges.length)
          return reason === undefined
            ? Effect.succeed(
              pinnedLogs.filter((log) => log.blockNumber >= filter.fromBlock && log.blockNumber <= filter.toBlock)
            )
            : Effect.fail(
              new EvmRpc.EvmRpcError({ reason, method: "eth_getLogs", endpoint: "fake", cause: new Error(reason._tag) })
            )
        })
    })
  )
  return { layer, state }
}

const streamFilter: Omit<EvmRpc.EvmLogsFilter, "fromBlock" | "toBlock"> = {
  addresses: [EUTBL, USTBL],
  topics: [TRANSFER]
}
const streamOptions = { filter: streamFilter, fromBlock: FROM, toBlock: TO }
// maxBlockRange 3 over the pinned range: four batches, the second without logs
const pinnedBatches = [[FROM, FROM + BigInt(2), 2], [FROM + BigInt(3), FROM + BigInt(5), 0], [
  FROM + BigInt(6),
  FROM + BigInt(8),
  1
], [TO, TO, 2]]

const bounds = (batches: ReadonlyArray<EvmIndexer.EvmIndexerBatch>) =>
  batches.map((batch) => [batch.fromBlock, batch.toBlock, batch.logs.length])

const collect = (options: Parameters<EvmIndexer.EvmIndexer["Service"]["streamLogs"]>[0]) =>
  Effect.gen(function*() {
    const batches = new Array<EvmIndexer.EvmIndexerBatch>()
    const exit = yield* (yield* EvmIndexer.EvmIndexer).streamLogs(options).pipe(
      Stream.runForEach((batch) => Effect.sync(() => batches.push(batch))),
      Effect.exit
    )
    return { batches, exit }
  })

describe("EvmIndexer.streamLogs", () => {
  it.effect("catches up in batches of maxBlockRange, empty ones included, and ends at toBlock", () => {
    const { layer, state } = fakeRpc(TO + BigInt(5))
    return provide(collect(streamOptions), layer, { confirmations: 0, maxBlockRange: 3 }).pipe(
      Effect.map(({ batches, exit }) => {
        expect(Exit.isSuccess(exit)).toBe(true)
        expect(bounds(batches)).toStrictEqual(pinnedBatches)
        expect(batches.flatMap((batch) => batch.logs)).toStrictEqual(pinnedLogs)
        expect(state.ranges).toStrictEqual(pinnedBatches.map(([from, to]) => [from, to]))
      })
    )
  })

  it.effect("emits a batch without logs", () => {
    const { layer } = fakeRpc(TO)
    const options = { ...streamOptions, fromBlock: FROM + BigInt(3), toBlock: FROM + BigInt(5) }
    return provide(collect(options), layer, { confirmations: 0 }).pipe(
      Effect.map(({ batches }) => expect(bounds(batches)).toStrictEqual([[FROM + BigInt(3), FROM + BigInt(5), 0]]))
    )
  })

  it.effect("is empty without a call when fromBlock > toBlock", () => {
    const { layer, state } = fakeRpc(TO)
    return provide(collect({ ...streamOptions, fromBlock: TO + BigInt(1) }), layer).pipe(
      Effect.map(({ batches }) => {
        expect(batches).toStrictEqual([])
        expect(state.ranges).toStrictEqual([])
      })
    )
  })

  for (const pollInterval of [undefined, "1 minute"] as const) {
    it.effect(`polls the head every ${pollInterval ?? "10 seconds (default)"} once caught up`, () =>
      Effect.gen(function*() {
        const wait = pollInterval === undefined ? EvmIndexer.DEFAULT_POLL_INTERVAL : Duration.minutes(1)
        const { layer, state } = fakeRpc(FROM + BigInt(2))
        const batches = new Array<EvmIndexer.EvmIndexerBatch>()
        const options = { filter: streamOptions.filter, fromBlock: FROM, pollInterval }
        const run = Effect.gen(function*() {
          yield* (yield* EvmIndexer.EvmIndexer).streamLogs(options).pipe(
            Stream.runForEach((batch) => Effect.sync(() => batches.push(batch)))
          )
        })
        yield* provide(run, layer, { confirmations: 0, maxBlockRange: 3 }).pipe(Effect.forkChild)
        yield* TestClock.adjust(0)
        expect(bounds(batches)).toStrictEqual(pinnedBatches.slice(0, 1))
        state.head = TO
        yield* TestClock.adjust(Duration.subtract(wait, Duration.millis(1)))
        expect(batches).toHaveLength(1)
        yield* TestClock.adjust(Duration.millis(1))
        expect(bounds(batches)).toStrictEqual(pinnedBatches)
        yield* TestClock.adjust(Duration.times(wait, 3))
        expect(batches).toHaveLength(4)
        expect(state.ranges).toHaveLength(4)
      }))
  }

  it.effect("waits for toBlock to be confirmed", () =>
    Effect.gen(function*() {
      const { layer, state } = fakeRpc(TO - BigInt(1))
      const fiber = yield* provide(collect(streamOptions), layer, { confirmations: 0 }).pipe(Effect.forkChild)
      yield* TestClock.adjust(0)
      state.head = TO + BigInt(10)
      yield* TestClock.adjust(EvmIndexer.DEFAULT_POLL_INTERVAL)
      const { batches } = yield* Fiber.join(fiber)
      expect(bounds(batches)).toStrictEqual([[FROM, TO - BigInt(1), 3], [TO, TO, 2]])
    }))

  for (const reason of [new JsonRpc.Unavailable(), new JsonRpc.InvalidResponse(), new JsonRpc.Lagging()]) {
    it.effect(`retries a step failing with ${reason._tag} at the same block`, () => {
      const { layer, state } = fakeRpc(TO, new Map([[2, reason]]))
      return provide(collect({ ...streamOptions, retry: Schedule.recurs(1) }), layer, {
        confirmations: 0,
        maxBlockRange: 3
      }).pipe(Effect.map(({ batches, exit }) => {
        expect(Exit.isSuccess(exit)).toBe(true)
        expect(bounds(batches)).toStrictEqual(pinnedBatches)
        expect(state.ranges[1]).toStrictEqual(state.ranges[2])
        expect(state.ranges).toHaveLength(5)
      }))
    })
  }

  for (
    const reason of [
      new JsonRpc.Pruned(),
      new JsonRpc.Rejected(),
      new JsonRpc.WrongNetwork({ expected: "a", actual: "b" })
    ]
  ) {
    it.effect(`fails at once on ${reason._tag}, retry or not`, () => {
      const { layer, state } = fakeRpc(TO, new Map([[2, reason]]))
      return provide(collect({ ...streamOptions, retry: Schedule.recurs(5) }), layer, {
        confirmations: 0,
        maxBlockRange: 3
      }).pipe(Effect.map(({ batches, exit }) => {
        expect(Exit.findErrorOption(exit)).toMatchObject({ value: { reason } })
        expect(batches).toHaveLength(1)
        expect(state.ranges).toHaveLength(2)
      }))
    })
  }

  it.effect("retries a step whose lastConfirmedBlock fails with a transient reason at the same block", () => {
    const { layer, state } = fakeRpc(TO, new Map(), new Map([[2, new JsonRpc.Unavailable()]]))
    return provide(collect({ ...streamOptions, retry: Schedule.recurs(1) }), layer, {
      confirmations: 0,
      maxBlockRange: 3
    }).pipe(Effect.map(({ batches, exit }) => {
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(bounds(batches)).toStrictEqual(pinnedBatches)
      expect(state.ranges).toStrictEqual(pinnedBatches.map(([from, to]) => [from, to]))
      expect(state.heads).toBe(5)
    }))
  })

  it.effect("fails with the last error once the retry schedule is exhausted", () => {
    const { layer, state } = fakeRpc(
      TO,
      new Map<number, JsonRpc.Reason>([[2, new JsonRpc.Unavailable()], [3, new JsonRpc.Lagging()]])
    )
    return provide(collect({ ...streamOptions, retry: Schedule.recurs(1) }), layer, {
      confirmations: 0,
      maxBlockRange: 3
    }).pipe(Effect.map(({ batches, exit }) => {
      expect(Exit.findErrorOption(exit)).toMatchObject({ value: { reason: { _tag: "Lagging" } } })
      expect(batches).toHaveLength(1)
      expect(state.ranges).toHaveLength(3)
    }))
  })

  it.effect("fails on the first failure without retry", () => {
    const { layer, state } = fakeRpc(TO, new Map([[2, new JsonRpc.Unavailable()]]))
    return provide(collect(streamOptions), layer, { confirmations: 0, maxBlockRange: 3 }).pipe(
      Effect.map(({ batches, exit }) => {
        expect(Exit.findErrorOption(exit)).toMatchObject({ value: { reason: { _tag: "Unavailable" } } })
        expect(batches).toHaveLength(1)
        expect(state.ranges).toHaveLength(2)
      })
    )
  })
})

describe("EvmNetwork.defaultConfirmations", () => {
  it("is a positive integer for every network, testnets as their mainnet", () => {
    for (const network of EvmNetwork.networks) {
      expect(Number.isSafeInteger(EvmNetwork.defaultConfirmations(network)), network).toBe(true)
      expect(EvmNetwork.defaultConfirmations(network)).toBeGreaterThan(0)
    }
    expect(EvmNetwork.defaultConfirmations("Ethereum")).toBe(64)
    expect(EvmNetwork.defaultConfirmations("Sepolia")).toBe(64)
    expect(EvmNetwork.defaultConfirmations("Arbitrum")).toBe(240)
  })
})
