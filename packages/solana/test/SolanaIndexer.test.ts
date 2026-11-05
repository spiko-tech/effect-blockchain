import * as Replay from "@effect-blockchain/core/test/utils/replay"
import { SolanaAddress } from "@effect-blockchain/solana/SolanaAddress"
import * as SolanaIndexer from "@effect-blockchain/solana/SolanaIndexer"
import * as SolanaRpc from "@effect-blockchain/solana/SolanaRpc"
import { SolanaTransactionHash } from "@effect-blockchain/solana/SolanaTransactionHash"
import { describe, expect, it } from "@effect/vitest"
import { getBase58Decoder } from "@solana/kit"
import * as Arr from "effect/Array"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as TestClock from "effect/testing/TestClock"

const fixtures = new URL("fixtures/", import.meta.url)

const Entry = Schema.Struct({
  signature: Schema.String,
  slot: Schema.Number,
  blockTime: Schema.NullOr(Schema.Number),
  err: Schema.Json,
  memo: Schema.NullOr(Schema.String)
})
type Entry = typeof Entry.Type

const Page = Schema.fromJsonString(Schema.Struct({ result: Schema.Array(Entry) }))
// the entries of a recorded `getSignaturesForAddress` reply
const recorded = (name: string) => Schema.decodeUnknownSync(Page)(Replay.load(fixtures, "alchemy", name).body).result

// a valid signature, distinct per `n`
const signature = (n: number) =>
  SolanaTransactionHash.make(
    getBase58Decoder().decode(new Uint8Array(64).map((_, i) => i < 4 ? (n >> (8 * i)) & 255 : 7))
  )
const entry = (n: number, slot: number, err: Schema.Json = null): Entry => ({
  signature: signature(n),
  slot,
  blockTime: null,
  err,
  memo: null
})

const reply = (id: number, body: object) => Response.json({ jsonrpc: "2.0", id, ...body })

/**
 * Real replies replayed for `getGenesisHash`, `getSlot` and `getTransaction`, and a fake node serving
 * `getSignaturesForAddress` from `history` (newest first) by `before` and `limit`: the recorded pages were taken with
 * `until` and `limit: 5`, which the indexer never sends, so their entries become part of a history instead.
 * `synthetic` transactions are answered by the fake node too, `lagging` endpoints answer -32016.
 */
const setup = (options: {
  readonly history: ReadonlyArray<Entry>
  readonly cases?: ReadonlyArray<string>
  readonly synthetic?: ReadonlyArray<Entry>
  readonly lagging?: ReadonlyArray<string>
  readonly endpoints?: Arr.NonEmptyReadonlyArray<string>
  readonly confirmations?: number | undefined
}) => {
  const cases = ["getGenesisHash", ...options.cases ?? []]
  const endpoints: Arr.NonEmptyReadonlyArray<string> = options.endpoints ?? ["alchemy"]
  const replay = Replay.replay(fixtures, Arr.map(endpoints, (name) => ({ name, provider: "alchemy", cases })))
  const pages: Array<string> = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const name = new URL(String(input)).hostname.replace(/\.fixture$/u, "")
    const text = await new Response(init?.body).text()
    const json: {
      id: number
      method: string
      params: [string, { readonly before?: string; readonly limit?: number }]
    } = JSON.parse(text)
    if (json.method === "getSignaturesForAddress") {
      const [, config] = json.params
      pages.push(`${name} ${JSON.stringify(config)}`)
      if (options.lagging?.includes(name)) {
        return reply(json.id, { error: { code: -32016, message: "min context slot" } })
      }
      const start = options.history.findIndex((e) => e.signature === config.before) + 1
      return reply(json.id, { result: options.history.slice(start, start + (config.limit ?? 1000)) })
    }
    const fake = options.synthetic?.find((e) => json.method === "getTransaction" && e.signature === json.params[0])
    if (fake !== undefined) {
      return reply(json.id, {
        result: { slot: fake.slot, blockTime: null, transaction: ["AQ==", "base64"], meta: { err: fake.err } }
      })
    }
    return replay.fetch(input, { ...init, body: text })
  }
  // without confirmations, `layer()` with no argument
  const indexer = options.confirmations === undefined
    ? SolanaIndexer.layer()
    : SolanaIndexer.layer({ confirmations: options.confirmations })
  const layer = indexer.pipe(
    Layer.provide(SolanaRpc.layer({ network: "Solana", endpoints: replay.endpoints, retries: 0 })),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))
  )
  const run = <A, E>(f: (indexer: SolanaIndexer.SolanaIndexer["Service"]) => Effect.Effect<A, E>) =>
    replay.check(
      Effect.gen(function*() {
        return yield* f(yield* SolanaIndexer.SolanaIndexer)
      }).pipe(Effect.provide(layer))
    )
  return { run, pages, served: replay.served }
}

const EUTBL = SolanaAddress.make("6rS8E5CQHLHmLenNNevUdJ9APzKNairr1kfWAM3EhDX3")
const TX_1 = "2ijR446DGZ3zFMDdp5JrbonSpRwrvN4bGK7oGiLpn5DpR9eCFHZjMPh89feRiuygcVhhY6HxP64y5xtnVfKJutz1"
const TX_2 = "2X2K6U3mUT7PFkcuh3N3u5T7ZaVdYKZh9eEHjfD4U92sYLqduHddwbCDDbZhyQbZZjMPdeKCzLEiNLR2LDWZzake"
const UNKNOWN_TX = "5UfDuX7WXYZdgnWkLhKnga5PsaFdMNQdi5SBPYB4RY5UBbQDN3kQz3VEABDaGbNkYPhGMaFKaLwUMcnMnEHG77v"
const TX_1_SLOT = 443760316
const TX_2_SLOT = 443117956
const instructionError = { InstructionError: ["0", { Custom: "1" }] }

// 998 newer entries, then one just above TX_1's slot: the first page (1000) ends with TX_1, a full page whose last
// slot is in range, so the indexer reads a second page
const newer = Array.from({ length: 998 }, (_, i) => entry(i, 450_000_000 - i))
const aboveRange = entry(1000, TX_1_SLOT + 1)
const failed = entry(1001, 443_500_000, instructionError)
const [tx1, ...olderPage1] = recorded("getSignaturesForAddress-page-1")
const history = [
  ...newer,
  aboveRange,
  tx1,
  failed,
  ...olderPage1,
  ...recorded("getSignaturesForAddress-page-2")
]
const range = { address: EUTBL, fromBlock: BigInt(TX_2_SLOT), toBlock: BigInt(TX_1_SLOT) }

describe("SolanaIndexer", () => {
  it.effect("fetches a range over two pages in chain order, filtering both ends, keeping a failed transaction", () => {
    const { pages, run, served } = setup({
      history,
      cases: ["getTransaction-eutbl-1", "getTransaction-eutbl-2"],
      synthetic: [failed]
    })
    return run((indexer) => indexer.fetchTransactions(range)).pipe(Effect.map((txs) => {
      expect(txs.map((tx) => [tx.signature, tx.slot])).toStrictEqual([
        [TX_2, BigInt(TX_2_SLOT)],
        [failed.signature, BigInt(failed.slot)],
        [TX_1, BigInt(TX_1_SLOT)]
      ])
      expect(txs.map((tx) => tx.err)).toStrictEqual([null, instructionError, null])
      expect(txs[0]).toMatchObject({ blockTime: BigInt(1788168720), meta: { err: null, fee: "11173" } })
      expect(txs[2]?.transaction.startsWith("AVYBJWgkGJhjpWDnX/jt")).toBe(true)
      expect(pages).toStrictEqual([
        `alchemy {"limit":1000,"commitment":"finalized","minContextSlot":${TX_1_SLOT}}`,
        `alchemy {"before":"${TX_1}","limit":1000,"commitment":"finalized","minContextSlot":${TX_1_SLOT}}`
      ])
      expect(served).toStrictEqual([
        "alchemy getGenesisHash",
        "alchemy getTransaction-eutbl-2",
        "alchemy getTransaction-eutbl-1"
      ])
    }))
  })

  it.effect("returns nothing for a range without transactions, stopping at the first page below it", () => {
    const { pages, run } = setup({ history })
    return run((indexer) =>
      indexer.fetchTransactions({ address: EUTBL, fromBlock: BigInt(TX_1_SLOT + 2), toBlock: BigInt(449_000_000) })
    ).pipe(Effect.map((txs) => {
      expect(txs).toStrictEqual([])
      expect(pages.length).toBe(1)
    }))
  })

  it.effect("returns nothing for an address without history", () => {
    const { pages, run } = setup({ history: [] })
    return run((indexer) => indexer.fetchTransactions(range)).pipe(Effect.map((txs) => {
      expect(txs).toStrictEqual([])
      expect(pages.length).toBe(1)
    }))
  })

  it.effect("returns nothing without a call when fromBlock > toBlock", () => {
    const { pages, run, served } = setup({ history })
    return run((indexer) => indexer.fetchTransactions({ ...range, fromBlock: range.toBlock + BigInt(1) })).pipe(
      Effect.map((txs) => {
        expect(txs).toStrictEqual([])
        expect(pages).toStrictEqual([])
        expect(served).toStrictEqual([])
      })
    )
  })

  it.effect("reverses the node's order within a slot", () => {
    const a = entry(1, 100)
    const b = entry(2, 100)
    const { run } = setup({ history: [entry(3, 101), a, b], synthetic: [a, b] })
    return run((indexer) => indexer.fetchTransactions({ address: EUTBL, fromBlock: BigInt(100), toBlock: BigInt(100) }))
      .pipe(Effect.map((txs) => expect(txs.map((tx) => tx.signature)).toStrictEqual([b.signature, a.signature])))
  })

  it.effect("fails Pruned when a listed transaction is not returned", () => {
    const { run } = setup({
      history: [entry(0, 100, null), { ...entry(1, 99), signature: UNKNOWN_TX }],
      cases: ["getTransaction-unknown"]
    })
    return run((indexer) =>
      Effect.flip(indexer.fetchTransactions({ address: EUTBL, fromBlock: BigInt(99), toBlock: BigInt(99) }))
    ).pipe(Effect.map((error) => expect(error).toMatchObject({ reason: "Pruned", method: "getTransaction" })))
  })

  it.effect("falls back to the next endpoint when one has not reached toBlock", () => {
    const { pages, run } = setup({
      history,
      endpoints: ["lagging", "alchemy"],
      lagging: ["lagging"],
      cases: ["getTransaction-eutbl-1", "getTransaction-eutbl-2"],
      synthetic: [failed]
    })
    return run((indexer) => indexer.fetchTransactions(range)).pipe(Effect.map((txs) => {
      expect(txs.length).toBe(3)
      expect(pages.map((page) => page.split(" ")[0])).toStrictEqual(["lagging", "alchemy", "lagging", "alchemy"])
    }))
  })

  it.effect("lastConfirmedBlock is the finalized slot minus the confirmations, never below 0", () =>
    Effect.gen(function*() {
      const run = (confirmations?: number) =>
        setup({ history: [], cases: ["getSlot"], confirmations }).run((indexer) => indexer.lastConfirmedBlock)
      expect(yield* run()).toBe(BigInt(464860372))
      expect(yield* run(372)).toBe(BigInt(464860000))
      expect(yield* run(1_000_000_000)).toBe(BigInt(0))
    }))
})

// a signature listed at `slot`, distinct per `n`
const info = (n: number, slot: number): SolanaRpc.SolanaSignatureInfo => ({
  signature: signature(n),
  slot: BigInt(slot),
  blockTime: null,
  err: null,
  memo: null
})
// in chain order: slot 11 has three signatures
const chain = [info(0, 10), info(1, 11), info(2, 11), info(3, 11), info(4, 13), info(5, 15), info(6, 17)]
const FROM = BigInt(10)
const TO = BigInt(20)
// maxBatchSize 2 over [10, 20]: slot 11 stays whole in the first batch, the bounds tile the range up to toBlock
const pinnedBatches = [[FROM, BigInt(11), 4], [BigInt(12), BigInt(15), 2], [BigInt(16), TO, 1]]

/**
 * A fake `SolanaRpc` over `chain`: the head is `state.head`, every call is logged in `state.calls` (a transaction by
 * its index in `chain`) and the call numbered `n` (from 1) fails with `failAt.get(n)`.
 */
const fakeRpc = (head: bigint, failAt: ReadonlyMap<number, SolanaRpc.SolanaRpcError["reason"]> = new Map()) => {
  const state = { head, calls: new Array<string>() }
  const call = <A>(method: string, value: () => A) =>
    Effect.suspend(() => {
      state.calls.push(method)
      const reason = failAt.get(state.calls.length)
      return reason === undefined
        ? Effect.sync(value)
        : Effect.fail(new SolanaRpc.SolanaRpcError({ reason, method, endpoint: "fake", cause: new Error(reason) }))
    })
  const history = Arr.reverse(chain)
  const layer = Layer.succeed(
    SolanaRpc.SolanaRpc,
    SolanaRpc.SolanaRpc.of({
      network: "Solana",
      getGenesisHash: Effect.die("unused"),
      getSlot: () => call("getSlot", () => state.head),
      getSignaturesForAddress: ({ before, limit }) =>
        call("getSignaturesForAddress", () => {
          const start = history.findIndex((e) => e.signature === before) + 1
          return history.slice(start, start + (limit ?? 1000))
        }),
      getTransaction: ({ signature }) => {
        const index = chain.findIndex((e) => e.signature === signature)
        return call(`getTransaction ${index}`, () => ({
          slot: chain[index]?.slot ?? BigInt(0),
          blockTime: null,
          transaction: "AQ==",
          meta: null
        }))
      }
    })
  )
  return { layer, state }
}

const provide = <A, E>(
  effect: Effect.Effect<A, E, SolanaIndexer.SolanaIndexer>,
  rpc: Layer.Layer<SolanaRpc.SolanaRpc>,
  options: Parameters<typeof SolanaIndexer.layer>[0] = { confirmations: 0, maxBatchSize: 2 }
) => effect.pipe(Effect.provide(SolanaIndexer.layer(options).pipe(Layer.provide(rpc))))

const streamOptions = { filter: { address: EUTBL }, fromBlock: FROM, toBlock: TO }

const bounds = (batches: ReadonlyArray<SolanaIndexer.SolanaIndexerBatch>) =>
  batches.map((batch) => [batch.fromBlock, batch.toBlock, batch.transactions.length])

const collect = (options: Parameters<SolanaIndexer.SolanaIndexer["Service"]["streamTransactions"]>[0]) =>
  Effect.gen(function*() {
    const batches = new Array<SolanaIndexer.SolanaIndexerBatch>()
    const exit = yield* (yield* SolanaIndexer.SolanaIndexer).streamTransactions(options).pipe(
      Stream.runForEach((batch) => Effect.sync(() => batches.push(batch))),
      Effect.exit
    )
    return { batches, exit }
  })

const allCalls = [
  "getSlot",
  "getSignaturesForAddress",
  ...chain.map((_, i) => `getTransaction ${i}`)
]

describe("SolanaIndexer.streamTransactions", () => {
  it.effect("catches up in groups of maxBatchSize without splitting a slot, tiling the range up to toBlock", () => {
    const { layer, state } = fakeRpc(TO + BigInt(5))
    return provide(collect(streamOptions), layer).pipe(Effect.map(({ batches, exit }) => {
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(bounds(batches)).toStrictEqual(pinnedBatches)
      expect(batches.flatMap((batch) => batch.transactions.map((tx) => tx.signature))).toStrictEqual(
        chain.map((e) => e.signature)
      )
      expect(state.calls).toStrictEqual(allCalls)
    }))
  })

  it.effect("fetches a group only once the previous batch is pulled", () => {
    const { layer, state } = fakeRpc(TO)
    const seen = new Array<number>()
    const run = Effect.gen(function*() {
      yield* (yield* SolanaIndexer.SolanaIndexer).streamTransactions(streamOptions).pipe(
        Stream.runForEach(() => Effect.sync(() => seen.push(state.calls.length)))
      )
    })
    return provide(run, layer).pipe(Effect.map(() => expect(seen).toStrictEqual([6, 8, 9])))
  })

  it.effect("defaults maxBatchSize to 100", () => {
    const { layer } = fakeRpc(TO)
    return provide(collect(streamOptions), layer, { confirmations: 0 }).pipe(
      Effect.map(({ batches }) => {
        expect(SolanaIndexer.DEFAULT_MAX_BATCH_SIZE).toBe(100)
        expect(bounds(batches)).toStrictEqual([[FROM, TO, 7]])
      })
    )
  })

  it.effect("emits one empty batch for a range without signatures", () => {
    const { layer, state } = fakeRpc(TO)
    return provide(collect({ ...streamOptions, fromBlock: BigInt(18) }), layer).pipe(
      Effect.map(({ batches }) => {
        expect(bounds(batches)).toStrictEqual([[BigInt(18), TO, 0]])
        expect(state.calls).toStrictEqual(["getSlot", "getSignaturesForAddress"])
      })
    )
  })

  it.effect("is empty without a call when fromBlock > toBlock", () => {
    const { layer, state } = fakeRpc(TO)
    return provide(collect({ ...streamOptions, fromBlock: TO + BigInt(1) }), layer).pipe(
      Effect.map(({ batches }) => {
        expect(batches).toStrictEqual([])
        expect(state.calls).toStrictEqual([])
      })
    )
  })

  it.effect("dies on a maxBatchSize that is not a positive integer", () =>
    Effect.gen(function*() {
      for (const maxBatchSize of [0, -1, 1.5]) {
        const { layer } = fakeRpc(TO)
        const exit = yield* Effect.exit(provide(collect(streamOptions), layer, { maxBatchSize }))
        expect(Result.getOrUndefined(Exit.findDefect(exit))).toBeInstanceOf(RangeError)
      }
    }))

  for (const pollInterval of [undefined, "1 minute"] as const) {
    it.effect(`polls the head every ${pollInterval ?? "10 seconds (default)"} once caught up`, () =>
      Effect.gen(function*() {
        const wait = pollInterval === undefined ? SolanaIndexer.DEFAULT_POLL_INTERVAL : Duration.minutes(1)
        const { layer, state } = fakeRpc(BigInt(11))
        const batches = new Array<SolanaIndexer.SolanaIndexerBatch>()
        const run = Effect.gen(function*() {
          yield* (yield* SolanaIndexer.SolanaIndexer).streamTransactions({
            filter: streamOptions.filter,
            fromBlock: FROM,
            pollInterval
          }).pipe(Stream.runForEach((batch) => Effect.sync(() => batches.push(batch))))
        })
        yield* provide(run, layer).pipe(Effect.forkChild)
        yield* TestClock.adjust(0)
        expect(bounds(batches)).toStrictEqual(pinnedBatches.slice(0, 1))
        state.head = TO
        yield* TestClock.adjust(Duration.subtract(wait, Duration.millis(1)))
        expect(batches).toHaveLength(1)
        yield* TestClock.adjust(Duration.millis(1))
        expect(bounds(batches)).toStrictEqual(pinnedBatches)
        yield* TestClock.adjust(Duration.times(wait, 3))
        expect(batches).toHaveLength(3)
        expect(state.calls.filter((c) => c === "getSlot")).toHaveLength(7)
      }))
  }

  it.effect("waits for toBlock to be confirmed", () =>
    Effect.gen(function*() {
      const { layer, state } = fakeRpc(BigInt(15))
      const fiber = yield* provide(collect(streamOptions), layer).pipe(Effect.forkChild)
      yield* TestClock.adjust(0)
      state.head = TO + BigInt(10)
      yield* TestClock.adjust(SolanaIndexer.DEFAULT_POLL_INTERVAL)
      const { batches } = yield* Fiber.join(fiber)
      expect(bounds(batches)).toStrictEqual(pinnedBatches)
    }))

  for (const reason of ["Unavailable", "InvalidResponse", "Lagging"] as const) {
    it.effect(`retries a group failing with ${reason} at the same group`, () => {
      const { layer, state } = fakeRpc(TO, new Map([[7, reason]]))
      return provide(collect({ ...streamOptions, retry: Schedule.recurs(1) }), layer).pipe(
        Effect.map(({ batches, exit }) => {
          expect(Exit.isSuccess(exit)).toBe(true)
          expect(bounds(batches)).toStrictEqual(pinnedBatches)
          expect(state.calls).toStrictEqual([...allCalls.slice(0, 7), ...allCalls.slice(6)])
        })
      )
    })
  }

  it.effect("retries a failed signature paging at the same slot", () => {
    const { layer, state } = fakeRpc(TO, new Map([[2, "Lagging"]]))
    return provide(collect({ ...streamOptions, retry: Schedule.recurs(1) }), layer).pipe(
      Effect.map(({ batches }) => {
        expect(bounds(batches)).toStrictEqual(pinnedBatches)
        expect(state.calls).toStrictEqual(["getSlot", "getSignaturesForAddress", ...allCalls])
      })
    )
  })

  it.effect("retries a step whose lastConfirmedBlock fails with a transient reason at the same slot", () => {
    const { layer, state } = fakeRpc(TO, new Map([[1, "Unavailable"]]))
    return provide(collect({ ...streamOptions, retry: Schedule.recurs(1) }), layer).pipe(
      Effect.map(({ batches }) => {
        expect(bounds(batches)).toStrictEqual(pinnedBatches)
        expect(state.calls).toStrictEqual(["getSlot", ...allCalls])
      })
    )
  })

  for (const reason of ["Pruned", "Rejected", "WrongNetwork"] as const) {
    it.effect(`fails at once on ${reason}, retry or not`, () => {
      const { layer, state } = fakeRpc(TO, new Map([[7, reason]]))
      return provide(collect({ ...streamOptions, retry: Schedule.recurs(5) }), layer).pipe(
        Effect.map(({ batches, exit }) => {
          expect(Exit.findErrorOption(exit)).toMatchObject({ value: { reason } })
          expect(batches).toHaveLength(1)
          expect(state.calls).toHaveLength(7)
        })
      )
    })
  }

  it.effect("fails with the last error once the retry schedule is exhausted", () => {
    const { layer, state } = fakeRpc(TO, new Map([[7, "Unavailable"], [8, "Lagging"]]))
    return provide(collect({ ...streamOptions, retry: Schedule.recurs(1) }), layer).pipe(
      Effect.map(({ batches, exit }) => {
        expect(Exit.findErrorOption(exit)).toMatchObject({ value: { reason: "Lagging" } })
        expect(batches).toHaveLength(1)
        expect(state.calls).toHaveLength(8)
      })
    )
  })

  it.effect("fails on the first failure without retry", () => {
    const { layer, state } = fakeRpc(TO, new Map([[7, "Unavailable"]]))
    return provide(collect(streamOptions), layer).pipe(
      Effect.map(({ batches, exit }) => {
        expect(Exit.findErrorOption(exit)).toMatchObject({ value: { reason: "Unavailable" } })
        expect(batches).toHaveLength(1)
        expect(state.calls).toHaveLength(7)
      })
    )
  })
})
