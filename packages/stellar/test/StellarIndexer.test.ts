import * as JsonRpc from "@effect-blockchain/core/JsonRpc"
// Runs the real `StellarRpc` + `StellarIndexer` layers over recorded Quasar replies (see StellarRpc.fixtures.test.ts),
// with hand-written replies for what the fixtures do not cover (the last page of a range, failures, edge cases).
import * as Replay from "@effect-blockchain/core/test/utils/replay"
import { StellarContractAddress } from "@effect-blockchain/stellar/StellarAddress"
import { StellarContractEvent } from "@effect-blockchain/stellar/StellarContractEvent"
import * as StellarIndexer from "@effect-blockchain/stellar/StellarIndexer"
import { toPassphrase } from "@effect-blockchain/stellar/StellarNetwork"
import * as StellarRpc from "@effect-blockchain/stellar/StellarRpc"
import { assert, describe, expect, it } from "@effect/vitest"
import { StrKey } from "@stellar/stellar-sdk"
import * as Arr from "effect/Array"
import * as Config from "effect/Config"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as TestClock from "effect/testing/TestClock"

type Params = { readonly [key: string]: Schema.Json }
type Reply = { readonly result: Schema.Json } | { readonly error: { code: number; message: string } }
// a hand-written reply, or `undefined` to answer from the recorded fixtures
type Handler = (method: string, params: Params | undefined) => Reply | undefined

interface Endpoint {
  readonly name: string
  readonly cases?: ReadonlyArray<string>
  readonly handle?: Handler
}

const EUTBL = StellarContractAddress.make("CBGV2QFQBBGEQRUKUMCPO3SZOHDDYO6SCP5CH6TW7EALKVHCXTMWDDOF")
const USTBL = StellarContractAddress.make("CARUUX2FZNPH6DGJOEUFSIUQWYHNL5AVDV7PMVSHWL7OBYIBFC76F4TO")
const contract = (n: number) => StellarContractAddress.make(StrKey.encodeContract(Buffer.alloc(32, n)))
// the recorded range and page size
const FROM = BigInt(65270680)
const TO = BigInt(65271880)
const LATEST = 65282941
const network = ["getNetwork", "getHealth"]

const toid = (ledger: number) => BigInt(ledger) << BigInt(32)
const eventId = (ledger: number, index = 0) =>
  `${toid(ledger).toString().padStart(19, "0")}-${String(index).padStart(10, "0")}`
// the RPC's cursor at the end of a scanned window: the largest cursor in `ledger`
const windowEnd = (ledger: number) => `${(toid(ledger) | BigInt(0xffffffff)).toString().padStart(19, "0")}-4294967295`

const rawEvent = (contractId: string, ledger: number, index = 0, inSuccessfulContractCall = true) => ({
  type: "contract",
  ledger,
  ledgerClosedAt: "2026-11-02T17:07:14Z",
  contractId,
  id: eventId(ledger, index),
  txHash: "cd624565b0c34653c21a2e2d7c08ed8e3bdeabe0684b08d89d96f96d7d9d1b6b",
  inSuccessfulContractCall,
  topic: ["AAAADwAAAAh0cmFuc2Zlcg=="],
  value: "AAAACgAAAAAAAAAAAAAAAAAAA60="
})

const page = (events: Array<Schema.Json>, cursor: string, latestLedger = 100): Reply => ({
  result: { events, cursor, latestLedger, oldestLedger: 1 }
})

const contractIdsOf = (params: Params | undefined) => {
  const filters = params?.filters
  return Array.isArray(filters) ? JSON.stringify(filters) : ""
}

// a fake node at ledger 100: every range is empty
const fake: Handler = (method, params) => {
  switch (method) {
    case "getNetwork":
      return { result: { passphrase: toPassphrase("Stellar"), protocolVersion: 23 } }
    case "getHealth":
      return { result: { status: "healthy", latestLedger: 100, oldestLedger: 1 } }
    case "getLatestLedger":
      return { result: { id: "ab", protocolVersion: 23, sequence: 100 } }
    default:
      return page([], windowEnd(Number(params?.endLedger) - 1))
  }
}

// one fetch for every endpoint, routed by host: the endpoint's handler first, then its recorded fixtures
const setup = (
  endpoints: Arr.NonEmptyReadonlyArray<Endpoint>,
  options: Parameters<typeof StellarIndexer.layer>[0] = {}
) => {
  const replay = Replay.replay(
    new URL("fixtures/", import.meta.url),
    Arr.map(endpoints, ({ cases = [], name }) => ({ name, provider: "quasar", cases }))
  )
  const requests: Array<string> = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const name = new URL(String(input)).hostname.replace(/\.fixture$/u, "")
    const body: { id: number; method: string; params?: Params } = JSON.parse(String(init?.body))
    requests.push(`${name} ${body.method} ${JSON.stringify(body.params ?? {})}`)
    const reply = endpoints.find((endpoint) => endpoint.name === name)?.handle?.(body.method, body.params)
    return reply === undefined ? replay.fetch(input, init) : Response.json({ jsonrpc: "2.0", id: body.id, ...reply })
  }
  const layer = StellarIndexer.layer(options).pipe(
    Layer.provide(StellarRpc.layer({ network: "Stellar", endpoints: replay.endpoints, retries: 0 })),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))
  )
  const run = <A, E>(f: (indexer: StellarIndexer.StellarIndexer["Service"]) => Effect.Effect<A, E>) =>
    replay.check(
      Effect.gen(function*() {
        return yield* f(yield* StellarIndexer.StellarIndexer)
      }).pipe(Effect.provide(layer))
    )
  return { run, served: replay.served, requests }
}

const ids = (events: ReadonlyArray<{ readonly id: string }>) => events.map((event) => event.id)

const EUTBL_IDS = [
  "0280335478937866240-0000000000",
  "0280335478937886720-0000000000",
  "0280335478937985024-0000000000",
  "0280335478938116096-0000000000",
  "0280335478938181632-0000000000",
  "0280335478938210304-0000000000"
]
const EUTBL_PAGE_2_CURSOR = "0280335478938210304-0000000000"
const USTBL_CURSOR = "0280339447488344064-0000000000"

// the recorded pages stop before `TO`: the RPC's last page, scanned to the end of the range, is hand-written
const lastPage = (cursor: string): Handler => (method, params) => {
  const pagination = params?.pagination
  return method === "getEvents" && typeof pagination === "object" && pagination !== null && "cursor" in pagination &&
      pagination.cursor === cursor
    ? page([], windowEnd(Number(TO)), LATEST)
    : undefined
}

const recorded = { fromBlock: FROM, toBlock: TO }
const quasar = (handle: Handler): Endpoint => ({
  name: "quasar",
  cases: [...network, "getEvents-eutbl-page-1", "getEvents-eutbl-page-2", "getEvents-ustbl"],
  handle
})

describe("StellarIndexer", () => {
  it.effect("fixture: pages EUTBL and USTBL over the recorded range", () =>
    Effect.gen(function*() {
      // one call per contract: the recorded requests each filter one contract, a single call would send both
      const { run, served } = setup([quasar((method, params) =>
        lastPage(EUTBL_PAGE_2_CURSOR)(method, params) ?? lastPage(USTBL_CURSOR)(method, params)
      )], { limit: 3 })
      const [eutbl, ustbl] = yield* run((indexer) =>
        Effect.all([
          indexer.fetchEvents({ ...recorded, contractIds: [EUTBL] }),
          indexer.fetchEvents({ ...recorded, contractIds: [USTBL] })
        ])
      )
      assert.deepStrictEqual(ids(eutbl), EUTBL_IDS)
      assert.deepStrictEqual(ustbl.map((event) => [event.contractId, event.blockNumber]), [
        [USTBL, BigInt(65270689)],
        [USTBL, BigInt(65271613)],
        [USTBL, BigInt(65271614)]
      ])
      assert.deepStrictEqual(served, [
        "quasar getNetwork",
        "quasar getHealth",
        "quasar getEvents-eutbl-page-1",
        "quasar getEvents-eutbl-page-2",
        "quasar getEvents-ustbl"
      ])
    }))

  it.effect("fixture: restarts a chunk once after a failed cursor page", () =>
    Effect.gen(function*() {
      let failures = 1
      const { run, served } = setup([quasar((method, params) => {
        if (params?.pagination !== undefined && JSON.stringify(params.pagination).includes(EUTBL_PAGE_2_CURSOR)) {
          return lastPage(EUTBL_PAGE_2_CURSOR)(method, params)
        }
        if (method === "getEvents" && params?.startLedger === undefined && failures > 0) {
          failures--
          return { error: { code: -32603, message: "database failure" } }
        }
        return undefined
      })], { limit: 3 })
      const events = yield* run((indexer) => indexer.fetchEvents({ ...recorded, contractIds: [EUTBL] }))
      // the first attempt's partial page is dropped, not duplicated
      assert.deepStrictEqual(ids(events), EUTBL_IDS)
      assert.deepStrictEqual(served, [
        "quasar getNetwork",
        "quasar getHealth",
        "quasar getEvents-eutbl-page-1",
        "quasar getEvents-eutbl-page-1",
        "quasar getEvents-eutbl-page-2"
      ])
    }))

  it.effect("fixture: fails with the second cursor page failure", () =>
    Effect.gen(function*() {
      const { run, served } = setup([quasar((method, params) =>
        method === "getEvents" && params?.startLedger === undefined
          ? { error: { code: -32603, message: "database failure" } }
          : undefined
      )], { limit: 3 })
      const error = yield* run((indexer) =>
        Effect.flip(indexer.fetchEvents({ ...recorded, contractIds: [EUTBL] }))
      )
      assert.strictEqual(error.reason._tag, "Unavailable")
      assert.strictEqual(error.endpoint, "quasar")
      assert.deepStrictEqual(served.filter((name) => name.includes("getEvents")), [
        "quasar getEvents-eutbl-page-1",
        "quasar getEvents-eutbl-page-1"
      ])
    }))

  it.effect("cuts the range into chunks of maxBlockRange ledgers", () =>
    Effect.gen(function*() {
      const { requests, run } = setup([{ name: "node", handle: fake }], { maxBlockRange: 10 })
      const events = yield* run((indexer) =>
        indexer.fetchEvents({ contractIds: [EUTBL], fromBlock: BigInt(10), toBlock: BigInt(34) })
      )
      assert.deepStrictEqual(events, [])
      const ranges = requests.filter((request) => request.includes("getEvents")).map((request) => {
        const params = JSON.parse(request.slice(request.indexOf("{")))
        return [params.startLedger, params.endLedger, params.pagination.limit]
      })
      // `endLedger` is exclusive
      assert.deepStrictEqual(ranges, [[10, 20, 1000], [20, 30, 1000], [30, 35, 1000]])
    }))

  it.effect("returns no events and sends nothing when fromBlock > toBlock", () =>
    Effect.gen(function*() {
      const { requests, run } = setup([{ name: "node", handle: fake }])
      const events = yield* run((indexer) =>
        indexer.fetchEvents({ contractIds: [EUTBL], fromBlock: BigInt(11), toBlock: BigInt(10) })
      )
      assert.deepStrictEqual(events, [])
      assert.deepStrictEqual(requests, [])
    }))

  it.effect("splits contractIds into groups of 5 and merges them in chain order", () =>
    Effect.gen(function*() {
      const contracts = Arr.makeBy(6, (n) => contract(n + 1))
      const { requests, run } = setup([{
        name: "node",
        handle: (method, params) =>
          method !== "getEvents" ? fake(method, params) : contractIdsOf(params).includes(contracts[5])
            ? page([rawEvent(contracts[5], 15)], windowEnd(20))
            : page([rawEvent(contracts[0], 12), rawEvent(contracts[4], 18)], windowEnd(20))
      }])
      const events = yield* run((indexer) =>
        indexer.fetchEvents({
          contractIds: [contracts[0], ...contracts.slice(1)],
          fromBlock: BigInt(10),
          toBlock: BigInt(20)
        })
      )
      assert.deepStrictEqual(events.map((event) => event.blockNumber), [BigInt(12), BigInt(15), BigInt(18)])
      const groups = requests.filter((request) => request.includes("getEvents")).map((request) =>
        JSON.parse(request.slice(request.indexOf("{"))).filters[0].contractIds.length
      )
      assert.deepStrictEqual(groups, [5, 1])
    }))

  it.effect("drops events of failed contract calls", () =>
    Effect.gen(function*() {
      const { run } = setup([{
        name: "node",
        handle: (method, params) =>
          method === "getEvents"
            ? page([rawEvent(EUTBL, 12, 0, false), rawEvent(EUTBL, 12, 1)], windowEnd(20))
            : fake(method, params)
      }])
      const events = yield* run((indexer) =>
        indexer.fetchEvents({ contractIds: [EUTBL], fromBlock: BigInt(10), toBlock: BigInt(20) })
      )
      assert.deepStrictEqual(ids(events), [eventId(12, 1)])
    }))

  it.effect("fails Pruned from the retention guard", () =>
    Effect.gen(function*() {
      const { run } = setup([{
        name: "node",
        handle: (method, params) =>
          method === "getHealth"
            ? { result: { status: "healthy", latestLedger: 100, oldestLedger: 50 } }
            : fake(method, params)
      }])
      const error = yield* run((indexer) =>
        Effect.flip(indexer.fetchEvents({ contractIds: [EUTBL], fromBlock: BigInt(10), toBlock: BigInt(20) }))
      )
      assert.strictEqual(error.reason._tag, "Pruned")
    }))

  it.effect("lastConfirmedBlock is the latest ledger minus the confirmations, never below 0", () =>
    Effect.gen(function*() {
      const latest = (options: Parameters<typeof StellarIndexer.layer>[0]) =>
        setup([{ name: "node", handle: fake }], options).run((indexer) => indexer.lastConfirmedBlock)
      assert.strictEqual(yield* latest({}), BigInt(100))
      assert.strictEqual(yield* latest({ confirmations: 5 }), BigInt(95))
      assert.strictEqual(yield* latest({ confirmations: 200 }), BigInt(0))
    }))

  it.effect("dies on a maxBlockRange that is not a positive integer", () =>
    Effect.gen(function*() {
      for (const maxBlockRange of [0, -1, 1.5]) {
        const exit = yield* Effect.exit(
          setup([{ name: "node", handle: fake }], { maxBlockRange }).run((indexer) => indexer.lastConfirmedBlock)
        )
        assert.instanceOf(Result.getOrUndefined(Exit.findDefect(exit)), RangeError)
      }
    }))
})

// ledgers 10 to 19, maxBlockRange 3: four batches, the second without events. The event of a failed call is dropped.
const S_FROM = BigInt(10)
const S_TO = BigInt(19)
const streamEvents = Schema.decodeUnknownSync(Schema.Array(StellarContractEvent))([
  rawEvent(USTBL, 10),
  rawEvent(USTBL, 12),
  rawEvent(EUTBL, 14, 0, false),
  rawEvent(USTBL, 17),
  rawEvent(USTBL, 19),
  rawEvent(EUTBL, 19, 1)
])
const pinnedBatches: Array<readonly [bigint, bigint, number]> = [[S_FROM, S_FROM + BigInt(2), 2], [
  S_FROM + BigInt(3),
  S_FROM + BigInt(5),
  0
], [
  S_FROM + BigInt(6),
  S_FROM + BigInt(8),
  1
], [S_TO, S_TO, 2]]
const pinnedRanges = pinnedBatches.map(([from, to]) => [from, to] as const)

// A fake `StellarRpc`: `getLatestLedger` reads `state.head`, `getEvents` answers the events inside the range in one
// page and records it in `state.ranges`. The n-th `getEvents` call (1-based) fails with `failAt.get(n)` when set, the
// n-th `getLatestLedger` call with `headFailAt.get(n)`.
const fakeRpc = (
  head: bigint,
  failAt: ReadonlyMap<number, JsonRpc.Reason> = new Map(),
  headFailAt: ReadonlyMap<number, JsonRpc.Reason> = new Map()
) => {
  const state = { head, heads: 0, ranges: new Array<readonly [bigint, bigint]>() }
  const fail = (reason: JsonRpc.Reason, method: string) =>
    Effect.fail(new StellarRpc.StellarRpcError({ reason, method, endpoint: "fake", cause: new Error(reason._tag) }))
  const layer = Layer.succeed(
    StellarRpc.StellarRpc,
    StellarRpc.StellarRpc.of({
      network: "Stellar",
      getNetwork: Effect.die("unused"),
      getLatestLedger: Effect.suspend(() => {
        const reason = headFailAt.get(++state.heads)
        return reason === undefined
          ? Effect.succeed({ sequence: state.head, id: "ab", protocolVersion: 23 })
          : fail(reason, "getLatestLedger")
      }),
      getEvents: (filter) =>
        Effect.suspend(() => {
          state.ranges.push([filter.fromBlock, filter.toBlock])
          const reason = failAt.get(state.ranges.length)
          return reason === undefined
            ? Effect.succeed({
              events: streamEvents.filter((event) =>
                event.blockNumber >= filter.fromBlock && event.blockNumber <= filter.toBlock
              ),
              cursor: undefined
            })
            : fail(reason, "getEvents")
        })
    })
  )
  return { layer, state }
}

const streamOptions = { filter: { contractIds: [EUTBL, USTBL] as const }, fromBlock: S_FROM, toBlock: S_TO }

const bounds = (batches: ReadonlyArray<StellarIndexer.StellarIndexerBatch>) =>
  batches.map((batch) => [batch.fromBlock, batch.toBlock, batch.events.length] as const)

const collect = (options: Parameters<StellarIndexer.StellarIndexer["Service"]["streamEvents"]>[0]) =>
  Effect.gen(function*() {
    const batches = new Array<StellarIndexer.StellarIndexerBatch>()
    const exit = yield* (yield* StellarIndexer.StellarIndexer).streamEvents(options).pipe(
      Stream.runForEach((batch) => Effect.sync(() => batches.push(batch))),
      Effect.exit
    )
    return { batches, exit }
  })

const provide = <A, E>(
  effect: Effect.Effect<A, E, StellarIndexer.StellarIndexer>,
  rpc: Layer.Layer<StellarRpc.StellarRpc>,
  options?: Parameters<typeof StellarIndexer.layer>[0]
) => effect.pipe(Effect.provide(StellarIndexer.layer(options).pipe(Layer.provide(rpc))))

const reasonOf = (exit: Exit.Exit<unknown, StellarRpc.StellarRpcError>) =>
  Option.getOrUndefined(Exit.findErrorOption(exit))?.reason._tag

describe("StellarIndexer.streamEvents", () => {
  it.effect("catches up in batches of maxBlockRange, empty ones included, and ends at toBlock", () => {
    const { layer, state } = fakeRpc(S_TO + BigInt(5))
    return provide(collect(streamOptions), layer, { confirmations: 0, maxBlockRange: 3 }).pipe(
      Effect.map(({ batches, exit }) => {
        assert.isTrue(Exit.isSuccess(exit))
        assert.deepStrictEqual(bounds(batches), pinnedBatches)
        assert.deepStrictEqual(
          batches.flatMap((batch) => batch.events),
          streamEvents.filter((event) => event.inSuccessfulContractCall)
        )
        assert.deepStrictEqual(state.ranges, pinnedRanges)
      })
    )
  })

  it.effect("emits a batch without events", () => {
    const { layer } = fakeRpc(S_TO)
    const options = { ...streamOptions, fromBlock: S_FROM + BigInt(3), toBlock: S_FROM + BigInt(5) }
    return provide(collect(options), layer, { confirmations: 0 }).pipe(
      Effect.map(({ batches }) =>
        assert.deepStrictEqual(bounds(batches), [[S_FROM + BigInt(3), S_FROM + BigInt(5), 0]])
      )
    )
  })

  it.effect("is empty without a call when fromBlock > toBlock", () => {
    const { layer, state } = fakeRpc(S_TO)
    return provide(collect({ ...streamOptions, fromBlock: S_TO + BigInt(1) }), layer).pipe(
      Effect.map(({ batches }) => {
        assert.deepStrictEqual(batches, [])
        assert.deepStrictEqual(state.ranges, [])
      })
    )
  })

  for (const pollInterval of [undefined, "1 minute"] as const) {
    it.effect(`polls the latest ledger every ${pollInterval ?? "10 seconds (default)"} once caught up`, () =>
      Effect.gen(function*() {
        const wait = pollInterval === undefined ? StellarIndexer.DEFAULT_POLL_INTERVAL : Duration.minutes(1)
        const { layer, state } = fakeRpc(S_FROM + BigInt(2))
        const batches = new Array<StellarIndexer.StellarIndexerBatch>()
        const options = { filter: streamOptions.filter, fromBlock: S_FROM, pollInterval }
        const run = Effect.gen(function*() {
          yield* (yield* StellarIndexer.StellarIndexer).streamEvents(options).pipe(
            Stream.runForEach((batch) => Effect.sync(() => batches.push(batch)))
          )
        })
        yield* provide(run, layer, { confirmations: 0, maxBlockRange: 3 }).pipe(Effect.forkChild)
        yield* TestClock.adjust(0)
        assert.deepStrictEqual(bounds(batches), pinnedBatches.slice(0, 1))
        state.head = S_TO
        yield* TestClock.adjust(Duration.subtract(wait, Duration.millis(1)))
        assert.lengthOf(batches, 1)
        yield* TestClock.adjust(Duration.millis(1))
        assert.deepStrictEqual(bounds(batches), pinnedBatches)
        yield* TestClock.adjust(Duration.times(wait, 3))
        assert.lengthOf(batches, 4)
        assert.lengthOf(state.ranges, 4)
      }))
  }

  it.effect("waits for toBlock to be confirmed", () =>
    Effect.gen(function*() {
      const { layer, state } = fakeRpc(S_TO - BigInt(1))
      const fiber = yield* provide(collect(streamOptions), layer, { confirmations: 0 }).pipe(Effect.forkChild)
      yield* TestClock.adjust(0)
      state.head = S_TO + BigInt(10)
      yield* TestClock.adjust(StellarIndexer.DEFAULT_POLL_INTERVAL)
      const { batches } = yield* Fiber.join(fiber)
      assert.deepStrictEqual(bounds(batches), [[S_FROM, S_TO - BigInt(1), 3], [S_TO, S_TO, 2]])
    }))

  for (const reason of [new JsonRpc.Unavailable(), new JsonRpc.InvalidResponse(), new JsonRpc.Lagging()]) {
    it.effect(`retries a step failing with ${reason._tag} at the same ledger`, () => {
      const { layer, state } = fakeRpc(S_TO, new Map([[2, reason]]))
      return provide(collect({ ...streamOptions, retry: Schedule.recurs(1) }), layer, {
        confirmations: 0,
        maxBlockRange: 3
      }).pipe(Effect.map(({ batches, exit }) => {
        assert.isTrue(Exit.isSuccess(exit))
        assert.deepStrictEqual(bounds(batches), pinnedBatches)
        assert.deepStrictEqual(state.ranges[1], state.ranges[2])
        assert.lengthOf(state.ranges, 5)
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
      const { layer, state } = fakeRpc(S_TO, new Map([[2, reason]]))
      return provide(collect({ ...streamOptions, retry: Schedule.recurs(5) }), layer, {
        confirmations: 0,
        maxBlockRange: 3
      }).pipe(Effect.map(({ batches, exit }) => {
        assert.strictEqual(reasonOf(exit), reason._tag)
        assert.lengthOf(batches, 1)
        assert.lengthOf(state.ranges, 2)
      }))
    })
  }

  it.effect("fails Pruned at once, retry or not, when no endpoint retains fromBlock", () =>
    Effect.gen(function*() {
      // the real `StellarRpc`: the node keeps ledgers 50 to 100, the stream starts at 10. `getLatestLedger` already
      // told the head, so the retention comes from the node's own out-of-range error
      const { requests, run } = setup([{
        name: "node",
        handle: (method, params) =>
          method === "getEvents"
            ? { error: { code: -32600, message: "startLedger must be within the ledger range: 50 - 100" } }
            : fake(method, params)
      }])
      const exit = yield* run((indexer) =>
        indexer.streamEvents({ ...streamOptions, toBlock: undefined, retry: Schedule.recurs(5) }).pipe(
          Stream.runCollect,
          Effect.exit
        )
      )
      assert.strictEqual(reasonOf(exit), "Pruned")
      assert.lengthOf(requests.filter((request) => request.includes("getLatestLedger")), 1)
      assert.lengthOf(requests.filter((request) => request.includes("getEvents")), 1)
    }))

  it.effect("retries a step whose lastConfirmedBlock fails with a transient reason at the same ledger", () => {
    const { layer, state } = fakeRpc(S_TO, new Map(), new Map([[2, new JsonRpc.Unavailable()]]))
    return provide(collect({ ...streamOptions, retry: Schedule.recurs(1) }), layer, {
      confirmations: 0,
      maxBlockRange: 3
    }).pipe(Effect.map(({ batches, exit }) => {
      assert.isTrue(Exit.isSuccess(exit))
      assert.deepStrictEqual(bounds(batches), pinnedBatches)
      assert.deepStrictEqual(state.ranges, pinnedRanges)
      assert.strictEqual(state.heads, 5)
    }))
  })

  it.effect("fails with the last error once the retry schedule is exhausted", () => {
    const { layer, state } = fakeRpc(
      S_TO,
      new Map<number, JsonRpc.Reason>([[2, new JsonRpc.Unavailable()], [3, new JsonRpc.Lagging()]])
    )
    return provide(collect({ ...streamOptions, retry: Schedule.recurs(1) }), layer, {
      confirmations: 0,
      maxBlockRange: 3
    }).pipe(Effect.map(({ batches, exit }) => {
      assert.strictEqual(reasonOf(exit), "Lagging")
      assert.lengthOf(batches, 1)
      assert.lengthOf(state.ranges, 3)
    }))
  })

  it.effect("fails on the first failure without retry", () => {
    const { layer, state } = fakeRpc(S_TO, new Map([[2, new JsonRpc.Unavailable()]]))
    return provide(collect(streamOptions), layer, { confirmations: 0, maxBlockRange: 3 }).pipe(
      Effect.map(({ batches, exit }) => {
        assert.strictEqual(reasonOf(exit), "Unavailable")
        assert.lengthOf(batches, 1)
        assert.lengthOf(state.ranges, 2)
      })
    )
  })
})

describe("layerConfig", () => {
  const lastConfirmed = (env: Record<string, string>) =>
    Effect.gen(function*() {
      return yield* (yield* StellarIndexer.StellarIndexer).lastConfirmedBlock
    }).pipe(
      Effect.provide(
        StellarIndexer.layerConfig({ confirmations: Config.Int("STELLAR_CONFIRMATIONS") }).pipe(
          Layer.provide(
            Layer.mock(StellarRpc.StellarRpc)({
              network: "Stellar",
              getLatestLedger: Effect.succeed({ sequence: BigInt(100), id: "ab", protocolVersion: 23 })
            })
          ),
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env)))
        )
      )
    )

  it.effect("builds from config", () =>
    Effect.gen(function*() {
      expect(yield* lastConfirmed({ STELLAR_CONFIRMATIONS: "10" })).toBe(BigInt(90))
    }))

  it.effect("fails with a ConfigError when a value is missing", () =>
    Effect.gen(function*() {
      expect(yield* Effect.flip(lastConfirmed({}))).toMatchObject({ _tag: "ConfigError" })
    }))
})
