import * as Replay from "@effect-blockchain/core/test/utils/replay"
import { StarknetAddress } from "@effect-blockchain/starknet/StarknetAddress"
import { StarknetEvent } from "@effect-blockchain/starknet/StarknetEvent"
import * as StarknetIndexer from "@effect-blockchain/starknet/StarknetIndexer"
import * as StarknetRpc from "@effect-blockchain/starknet/StarknetRpc"
import { describe, expect, it } from "@effect/vitest"
import * as Arr from "effect/Array"
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

type Indexer = StarknetIndexer.StarknetIndexer["Service"]
type IndexerOptions = Parameters<typeof StarknetIndexer.layer>[0]

const provide = (
  endpoints: Arr.NonEmptyReadonlyArray<StarknetRpc.StarknetRpcEndpoint>,
  fetch: typeof globalThis.fetch,
  options: IndexerOptions
) =>
  StarknetIndexer.layer(options).pipe(
    Layer.provide(StarknetRpc.layer({ network: "Starknet", endpoints, retries: 0 })),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))
  )

const withIndexer = <A, E>(f: (indexer: Indexer) => Effect.Effect<A, E>) =>
  Effect.gen(function*() {
    return yield* f(yield* StarknetIndexer.StarknetIndexer)
  })

// real provider replies recorded by `scripts/record-fixtures.ts`
const fixtures = new URL("fixtures/", import.meta.url)
const EUTBL = StarknetAddress.make("0x04f5e0de717daa6aa8de63b1bf2e8d7823ec5b21a88461b1519d9dbc956fb7f2")
const LAST_CURSOR = "1380394-2"

describe("StarknetIndexer fixtures", () => {
  for (const provider of ["alchemy", "infura"] as const) {
    it.effect(`fixture: ${provider} fetchEvents pages across the cursor`, () => {
      const { check, endpoints, fetch: replay, served } = Replay.replay(fixtures, [
        { name: provider, cases: ["chainId", "blockNumber", "getEvents-page-1", "getEvents-page-2"] }
      ])
      // page 3 was not recorded: answer it with a hand-written last page
      const fetch: typeof globalThis.fetch = async (input, init) => {
        const body = await new Response(init?.body).text()
        return body.includes(`"continuation_token":"${LAST_CURSOR}"`)
          ? Response.json({ jsonrpc: "2.0", id: 1, result: { events: [] } })
          : replay(input, { ...init, body })
      }
      return check(
        withIndexer((indexer) =>
          Effect.gen(function*() {
            const events = yield* indexer.fetchEvents({
              address: EUTBL,
              fromBlock: BigInt(1380300),
              toBlock: BigInt(1380400)
            })
            expect(events).toHaveLength(10)
            expect(events[0]).toMatchObject({ fromAddress: EUTBL, blockNumber: BigInt(1380308) })
            expect(events[5]).toMatchObject({ blockNumber: BigInt(1380320) })
            const head = BigInt(JSON.parse(Replay.load(fixtures, provider, "blockNumber").body).result)
            expect(yield* indexer.lastConfirmedBlock).toBe(head)
            expect(served.filter((name) => name.includes("getEvents"))).toStrictEqual([
              `${provider} getEvents-page-1`,
              `${provider} getEvents-page-2`
            ])
          })
        ).pipe(Effect.provide(provide(endpoints, fetch, { chunkSize: 5 })))
      )
    })
  }
})

type Reply = { readonly result: Schema.Json } | { readonly error: { code: number; message: string } }
interface EventsFilter {
  readonly from_block: { readonly block_number: number }
  readonly to_block: { readonly block_number: number }
  readonly keys?: ReadonlyArray<ReadonlyArray<string>>
  readonly chunk_size: number
  readonly continuation_token?: string
}
type Node = (filter: EventsFilter) => Reply

const TOKEN = StarknetAddress.make("0x" + "11".repeat(32))
const SN_MAIN = "0x534e5f4d41494e"
const UNAVAILABLE = { error: { code: 63, message: "unexpected error" } }

const event = (block: number) => ({
  from_address: TOKEN,
  keys: ["0x99cd8bde557814842a3121e8ddfd433a539b8c9f14bf31ebf108d12e6196e9"],
  data: ["0x" + block.toString(16)],
  block_number: block,
  block_hash: "0x" + "ab".repeat(32),
  transaction_hash: "0x" + "cd".repeat(32)
})
const page = (blocks: ReadonlyArray<number>, token?: string): Reply => ({
  result: { events: blocks.map(event), ...(token !== undefined && { continuation_token: token }) }
})

// fake endpoints routed by host, each answering `starknet_getEvents` with its `Node`; head 1000
const setup = (nodes: Record<string, Node>, options: IndexerOptions = {}, head = 1000) => {
  const calls: Array<string> = []
  const filters: Array<EventsFilter> = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const name = new URL(String(input)).hostname.split(".")[0]
    const body: { id: number; method: string; params: { filter: EventsFilter } } = JSON.parse(
      await new Response(init?.body).text()
    )
    const reply: Reply = body.method === "starknet_chainId"
      ? { result: SN_MAIN }
      : body.method === "starknet_blockNumber"
      ? { result: head }
      : (() => {
        const { filter } = body.params
        calls.push(`${name}:${filter.continuation_token ?? "first"}`)
        filters.push(filter)
        return nodes[name](filter)
      })()
    return Response.json({ jsonrpc: "2.0", id: body.id, ...reply })
  }
  const names = Object.keys(nodes)
  if (!Arr.isReadonlyArrayNonEmpty(names)) throw new Error("setup needs at least one endpoint")
  const endpoints = Arr.map(names, (name) => ({ name, url: Redacted.make(`https://${name}.rpc.test/key`) }))
  const run = <A, E>(f: (indexer: Indexer) => Effect.Effect<A, E>) =>
    withIndexer(f).pipe(Effect.provide(provide(endpoints, fetch, options)))
  return { calls, filters, run }
}

const blocks = (events: ReadonlyArray<{ readonly blockNumber: bigint }>) => events.map((e) => Number(e.blockNumber))

describe("StarknetIndexer", () => {
  it.effect("lastConfirmedBlock is the head minus the confirmations, never below 0", () =>
    Effect.gen(function*() {
      expect(yield* setup({ a: () => page([]) }, { confirmations: 5 }, 100).run((i) => i.lastConfirmedBlock))
        .toBe(BigInt(95))
      expect(yield* setup({ a: () => page([]) }, { confirmations: 5 }, 3).run((i) => i.lastConfirmedBlock))
        .toBe(BigInt(0))
      expect(yield* setup({ a: () => page([]) }, {}, 42).run((i) => i.lastConfirmedBlock)).toBe(BigInt(42))
    }))

  it.effect("fromBlock above toBlock returns no events without a call", () => {
    const { calls, run } = setup({ a: () => page([1]) })
    return run((i) => i.fetchEvents({ address: TOKEN, fromBlock: BigInt(20), toBlock: BigInt(10) })).pipe(
      Effect.map((events) => {
        expect(events).toStrictEqual([])
        expect(calls).toStrictEqual([])
      })
    )
  })

  it.effect("splits the range into chunks of maxBlockRange blocks, both ends inclusive", () => {
    const { filters, run } = setup({
      a: ({ from_block, to_block }) => page([from_block.block_number, to_block.block_number])
    }, { maxBlockRange: 10 })
    return run((i) => i.fetchEvents({ address: TOKEN, fromBlock: BigInt(5), toBlock: BigInt(27) })).pipe(
      Effect.map((events) => {
        expect(filters.map((f) => [f.from_block.block_number, f.to_block.block_number])).toStrictEqual([
          [5, 14],
          [15, 24],
          [25, 27]
        ])
        expect(blocks(events)).toStrictEqual([5, 14, 15, 24, 25, 27])
      })
    )
  })

  it.effect("a single-block range is one chunk", () => {
    const { filters, run } = setup({ a: () => page([7]) }, { maxBlockRange: 1 })
    return run((i) => i.fetchEvents({ address: TOKEN, fromBlock: BigInt(7), toBlock: BigInt(7) })).pipe(
      Effect.map((events) => {
        expect(blocks(events)).toStrictEqual([7])
        expect(filters).toHaveLength(1)
      })
    )
  })

  it.effect("passes keys and the page size through, defaulting to 1000", () => {
    const keys = [["0x1"], [], ["0x2", "0x3"]]
    const first = setup({ a: () => page([]) }, { chunkSize: 50 })
    const second = setup({ a: () => page([]) })
    return Effect.gen(function*() {
      yield* first.run((i) => i.fetchEvents({ address: TOKEN, fromBlock: BigInt(1), toBlock: BigInt(2), keys }))
      yield* second.run((i) => i.fetchEvents({ address: TOKEN, fromBlock: BigInt(1), toBlock: BigInt(2) }))
      expect(first.filters[0]).toMatchObject({ keys, chunk_size: 50 })
      expect(second.filters[0].keys).toBeUndefined()
      expect(second.filters[0].chunk_size).toBe(1000)
    })
  })

  it.effect("restarts a chunk once through the fallback chain after a failed cursor page", () => {
    let firstPages = 0
    const { calls, run } = setup({
      // serves page 1, fails page 2, then is down
      a: (filter) =>
        filter.continuation_token !== undefined ? UNAVAILABLE : firstPages++ === 0 ? page([10], "a-1") : UNAVAILABLE,
      b: (filter) => filter.continuation_token === undefined ? page([10, 11], "b-1") : page([12])
    })
    return run((i) => i.fetchEvents({ address: TOKEN, fromBlock: BigInt(10), toBlock: BigInt(20) })).pipe(
      Effect.map((events) => {
        expect(blocks(events)).toStrictEqual([10, 11, 12])
        expect(calls).toStrictEqual(["a:first", "a:a-1", "a:first", "b:first", "b:b-1"])
      })
    )
  })

  it.effect("a second failure of the same chunk fails the call with that error", () => {
    const { calls, run } = setup({
      a: (filter) =>
        filter.continuation_token === undefined
          ? page([10], "a-1")
          : { error: { code: 33, message: "invalid continuation token" } }
    })
    return run((i) => Effect.flip(i.fetchEvents({ address: TOKEN, fromBlock: BigInt(10), toBlock: BigInt(20) })))
      .pipe(
        Effect.map((error) => {
          expect(error).toMatchObject({ reason: "Rejected", code: 33, endpoint: "a" })
          expect(calls).toStrictEqual(["a:first", "a:a-1", "a:first", "a:a-1"])
        })
      )
  })

  it.effect("a failed first page fails the call without a restart", () => {
    const { calls, run } = setup({ a: () => UNAVAILABLE })
    return run((i) => Effect.flip(i.fetchEvents({ address: TOKEN, fromBlock: BigInt(10), toBlock: BigInt(20) })))
      .pipe(
        Effect.map((error) => {
          expect(error).toMatchObject({ reason: "Unavailable", code: 63 })
          expect(calls).toStrictEqual(["a:first"])
        })
      )
  })

  it.effect("dies on a maxBlockRange that is not a positive integer", () =>
    Effect.gen(function*() {
      for (const maxBlockRange of [0, -1, 1.5]) {
        const exit = yield* Effect.exit(
          setup({ a: () => page([]) }, { maxBlockRange }).run((i) => i.lastConfirmedBlock)
        )
        expect(Result.getOrUndefined(Exit.findDefect(exit))).toBeInstanceOf(RangeError)
      }
    }))

  it.effect("a toBlock above the head fails Lagging from the rpc head guard", () => {
    const { calls, run } = setup({ a: () => page([]) }, {}, 15)
    return run((i) => Effect.flip(i.fetchEvents({ address: TOKEN, fromBlock: BigInt(10), toBlock: BigInt(20) })))
      .pipe(
        Effect.map((error) => {
          expect(error).toMatchObject({ reason: "Lagging" })
          expect(calls).toStrictEqual([])
        })
      )
  })
})

const FROM = BigInt(100)
const TO = BigInt(109)
// maxBlockRange 3 over [FROM, TO]: four batches, the second without events
const pinnedEvents = Schema.decodeUnknownSync(Schema.Array(StarknetEvent))([100, 101, 106, 109, 109].map(event))
const pinnedBatches = [[FROM, FROM + BigInt(2), 2], [FROM + BigInt(3), FROM + BigInt(5), 0], [
  FROM + BigInt(6),
  FROM + BigInt(8),
  1
], [TO, TO, 2]]

// A fake `StarknetRpc`: `starknet_blockNumber` reads `state.head`, `starknet_getEvents` answers the pinned events
// inside the range in one page and records it in `state.ranges`. The n-th `getEvents` call (1-based) fails with
// `failAt.get(n)` when set, the n-th `blockNumber` call with `headFailAt.get(n)`.
const fakeRpc = (
  head: bigint,
  failAt: ReadonlyMap<number, StarknetRpc.StarknetRpcErrorReason> = new Map(),
  headFailAt: ReadonlyMap<number, StarknetRpc.StarknetRpcErrorReason> = new Map()
) => {
  const state = { head, heads: 0, ranges: new Array<readonly [bigint, bigint]>() }
  const fail = (reason: StarknetRpc.StarknetRpcErrorReason, method: string) =>
    Effect.fail(new StarknetRpc.StarknetRpcError({ reason, method, endpoint: "fake", cause: new Error(reason) }))
  const layer = Layer.succeed(
    StarknetRpc.StarknetRpc,
    StarknetRpc.StarknetRpc.of({
      network: "Starknet",
      chainId: Effect.die("unused"),
      getTransactionReceipt: () => Effect.die("unused"),
      blockNumber: Effect.suspend(() => {
        const reason = headFailAt.get(++state.heads)
        return reason === undefined ? Effect.succeed(state.head) : fail(reason, "starknet_blockNumber")
      }),
      getEvents: (filter) =>
        Effect.suspend(() => {
          state.ranges.push([filter.fromBlock, filter.toBlock])
          const reason = failAt.get(state.ranges.length)
          return reason === undefined
            ? Effect.succeed({
              events: pinnedEvents.filter((e) => e.blockNumber >= filter.fromBlock && e.blockNumber <= filter.toBlock),
              cursor: undefined
            })
            : fail(reason, "starknet_getEvents")
        })
    })
  )
  return { layer, state }
}

const provideFake = <A, E>(
  effect: Effect.Effect<A, E, StarknetIndexer.StarknetIndexer>,
  rpc: Layer.Layer<StarknetRpc.StarknetRpc>,
  options?: IndexerOptions
) => effect.pipe(Effect.provide(StarknetIndexer.layer(options).pipe(Layer.provide(rpc))))

const streamOptions = { filter: { address: TOKEN }, fromBlock: FROM, toBlock: TO }

const bounds = (batches: ReadonlyArray<StarknetIndexer.StarknetIndexerBatch>) =>
  batches.map((batch) => [batch.fromBlock, batch.toBlock, batch.events.length])

const collect = (options: Parameters<Indexer["streamEvents"]>[0]) =>
  Effect.gen(function*() {
    const batches = new Array<StarknetIndexer.StarknetIndexerBatch>()
    const exit = yield* (yield* StarknetIndexer.StarknetIndexer).streamEvents(options).pipe(
      Stream.runForEach((batch) => Effect.sync(() => batches.push(batch))),
      Effect.exit
    )
    return { batches, exit }
  })

describe("StarknetIndexer.streamEvents", () => {
  it.effect("catches up in batches of maxBlockRange, empty ones included, and ends at toBlock", () => {
    const { layer, state } = fakeRpc(TO + BigInt(5))
    return provideFake(collect(streamOptions), layer, { confirmations: 0, maxBlockRange: 3 }).pipe(
      Effect.map(({ batches, exit }) => {
        expect(Exit.isSuccess(exit)).toBe(true)
        expect(bounds(batches)).toStrictEqual(pinnedBatches)
        expect(batches.flatMap((batch) => batch.events)).toStrictEqual(pinnedEvents)
        expect(state.ranges).toStrictEqual(pinnedBatches.map(([from, to]) => [from, to]))
      })
    )
  })

  it.effect("emits a batch without events", () => {
    const { layer } = fakeRpc(TO)
    const options = { ...streamOptions, fromBlock: FROM + BigInt(3), toBlock: FROM + BigInt(5) }
    return provideFake(collect(options), layer, { confirmations: 0 }).pipe(
      Effect.map(({ batches }) => expect(bounds(batches)).toStrictEqual([[FROM + BigInt(3), FROM + BigInt(5), 0]]))
    )
  })

  it.effect("is empty without a call when fromBlock > toBlock", () => {
    const { layer, state } = fakeRpc(TO)
    return provideFake(collect({ ...streamOptions, fromBlock: TO + BigInt(1) }), layer).pipe(
      Effect.map(({ batches }) => {
        expect(batches).toStrictEqual([])
        expect(state.ranges).toStrictEqual([])
        expect(state.heads).toBe(0)
      })
    )
  })

  for (const pollInterval of [undefined, "1 minute"] as const) {
    it.effect(`polls the head every ${pollInterval ?? "10 seconds (default)"} once caught up`, () =>
      Effect.gen(function*() {
        const wait = pollInterval === undefined ? StarknetIndexer.DEFAULT_POLL_INTERVAL : Duration.minutes(1)
        const { layer, state } = fakeRpc(FROM + BigInt(2))
        const batches = new Array<StarknetIndexer.StarknetIndexerBatch>()
        const options = { filter: streamOptions.filter, fromBlock: FROM, pollInterval }
        const run = Effect.gen(function*() {
          yield* (yield* StarknetIndexer.StarknetIndexer).streamEvents(options).pipe(
            Stream.runForEach((batch) => Effect.sync(() => batches.push(batch)))
          )
        })
        yield* provideFake(run, layer, { confirmations: 0, maxBlockRange: 3 }).pipe(Effect.forkChild)
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
      const fiber = yield* provideFake(collect(streamOptions), layer, { confirmations: 0 }).pipe(Effect.forkChild)
      yield* TestClock.adjust(0)
      state.head = TO + BigInt(10)
      yield* TestClock.adjust(StarknetIndexer.DEFAULT_POLL_INTERVAL)
      const { batches } = yield* Fiber.join(fiber)
      expect(bounds(batches)).toStrictEqual([[FROM, TO - BigInt(1), 3], [TO, TO, 2]])
    }))

  for (const reason of ["Unavailable", "InvalidResponse", "Lagging"] as const) {
    it.effect(`retries a step failing with ${reason} at the same block`, () => {
      const { layer, state } = fakeRpc(TO, new Map([[2, reason]]))
      return provideFake(collect({ ...streamOptions, retry: Schedule.recurs(1) }), layer, {
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

  for (const reason of ["Pruned", "Rejected", "WrongNetwork"] as const) {
    it.effect(`fails at once on ${reason}, retry or not`, () => {
      const { layer, state } = fakeRpc(TO, new Map([[2, reason]]))
      return provideFake(collect({ ...streamOptions, retry: Schedule.recurs(5) }), layer, {
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
    const { layer, state } = fakeRpc(TO, new Map(), new Map([[2, "Unavailable"]]))
    return provideFake(collect({ ...streamOptions, retry: Schedule.recurs(1) }), layer, {
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
    const { layer, state } = fakeRpc(TO, new Map([[2, "Unavailable"], [3, "Lagging"]]))
    return provideFake(collect({ ...streamOptions, retry: Schedule.recurs(1) }), layer, {
      confirmations: 0,
      maxBlockRange: 3
    }).pipe(Effect.map(({ batches, exit }) => {
      expect(Exit.findErrorOption(exit)).toMatchObject({ value: { reason: "Lagging" } })
      expect(batches).toHaveLength(1)
      expect(state.ranges).toHaveLength(3)
    }))
  })

  it.effect("fails on the first failure without retry", () => {
    const { layer, state } = fakeRpc(TO, new Map([[2, "Unavailable"]]))
    return provideFake(collect(streamOptions), layer, { confirmations: 0, maxBlockRange: 3 }).pipe(
      Effect.map(({ batches, exit }) => {
        expect(Exit.findErrorOption(exit)).toMatchObject({ value: { reason: "Unavailable" } })
        expect(batches).toHaveLength(1)
        expect(state.ranges).toHaveLength(2)
      })
    )
  })

  it.effect("a cursor page still failing after the chunk restart fails the step, then the stream retries it", () => {
    let cursorPages = 0
    const { calls, run } = setup({
      // pages 10 then 12; the cursor page fails twice: once before the chunk restart, once after it
      a: (filter) =>
        filter.continuation_token === undefined ? page([10], "a-1") : ++cursorPages <= 2 ? UNAVAILABLE : page([12])
    }, { confirmations: 0 })
    const options = { filter: { address: TOKEN }, fromBlock: BigInt(10), toBlock: BigInt(20) }
    return Effect.gen(function*() {
      const batches = yield* run((indexer) =>
        indexer.streamEvents({ ...options, retry: Schedule.recurs(1) }).pipe(Stream.runCollect)
      )
      expect(batches.map((batch) => [batch.fromBlock, batch.toBlock, blocks(batch.events)])).toStrictEqual([
        [BigInt(10), BigInt(20), [10, 12]]
      ])
      expect(calls).toStrictEqual(["a:first", "a:a-1", "a:first", "a:a-1", "a:first", "a:a-1"])
    })
  })
})
