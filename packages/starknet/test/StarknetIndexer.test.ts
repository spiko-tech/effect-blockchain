import * as Replay from "@effect-blockchain/core/test/utils/replay"
import { StarknetAddress } from "@effect-blockchain/starknet/StarknetAddress"
import * as StarknetIndexer from "@effect-blockchain/starknet/StarknetIndexer"
import * as StarknetRpc from "@effect-blockchain/starknet/StarknetRpc"
import { describe, expect, it } from "@effect/vitest"
import * as Arr from "effect/Array"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import type * as Schema from "effect/Schema"

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
