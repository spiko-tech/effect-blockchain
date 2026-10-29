import { StellarContractAddress } from "@effect-blockchain/stellar/StellarAddress"
import * as StellarIndexer from "@effect-blockchain/stellar/StellarIndexer"
import { afterAll, beforeAll, describe, expect, it, vi } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import { TestClock } from "effect/testing"

const address = StellarContractAddress.make("CCAANR7HZNOXYZD7SXS2WQLV5BAOXSRZ7V4O43IANSB355QN2RNG7WVC")
const txHash = "3fcd635d285c5b3a4d9b65a10f6c70c11132d8fafd32e82fea79103eb1a05924"
const filters = [{ type: "contract", contractIds: [address] }]

const rawEvent = (ledger: number, n: number, extra: Record<string, unknown> = {}) => ({
  type: "contract",
  ledger,
  ledgerClosedAt: "2026-07-21T20:44:01Z",
  contractId: address,
  id: `${String(ledger * 2 ** 32).padStart(19, "0")}-${String(n).padStart(10, "0")}`,
  transactionIndex: 1,
  operationIndex: 0,
  inSuccessfulContractCall: true,
  topic: ["AAAADwAAAAh0cmFuc2Zlcg=="],
  value: "AAAACgAAAAAAAAAAAAAAAAAAASw=",
  txHash,
  ...extra
})

const health = (latestLedger: number, oldestLedger = 1) => ({
  result: { status: "healthy", latestLedger, oldestLedger, ledgerRetentionWindow: 120960 }
})
const events = (evs: Array<unknown>, cursor = "c") => ({
  result: { events: evs, cursor, latestLedger: 0, oldestLedger: 1 }
})

type Reply = { status?: number; result?: unknown; error?: unknown }
type FakeRpc = { rpcUrl: string; replies: Array<Reply>; requests: Array<{ method: string; params: unknown }> }

// Fake JSON-RPC transport, one per RPC URL since tests run concurrently. Stubbed once for the whole file: the SDK's
// axios fetch adapter keeps the first `fetch` it sees.
const fakes = new Map<string, FakeRpc>()
let nextId = 0
const fakeRpc = (replies: Array<Reply>): FakeRpc => {
  const fake = { rpcUrl: `https://rpc-${nextId++}.test/`, replies, requests: [] }
  fakes.set(fake.rpcUrl, fake)
  return fake
}

beforeAll(() => {
  vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
    const fake = fakes.get(url)!
    fake.requests.push(JSON.parse(init.body))
    const { status = 200, ...body } = fake.replies.shift() ?? { status: 500 }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }), {
      status,
      headers: { "content-type": "application/json" }
    })
  })
})
afterAll(() => {
  vi.unstubAllGlobals()
})

const run = <A, E>(
  fake: FakeRpc,
  f: (indexer: StellarIndexer.StellarIndexer["Service"]) => Effect.Effect<A, E>,
  options: { confirmations?: number; limit?: number } = {}
) =>
  StellarIndexer.StellarIndexer.use(f).pipe(
    Effect.provide(StellarIndexer.layer({ network: "Stellar", rpcUrl: fake.rpcUrl, ...options }))
  )

const fetchEvents = (fake: FakeRpc, fromBlock: number, toBlock: number, options?: { limit?: number }) =>
  run(
    fake,
    (indexer) => indexer.fetchEvents({ address, fromBlock: BigInt(fromBlock), toBlock: BigInt(toBlock) }),
    options
  )

describe("StellarIndexer", () => {
  it.effect("lastConfirmedBlock uses the network default confirmations (0)", () =>
    Effect.gen(function*() {
      expect(yield* run(fakeRpc([health(1000)]), (indexer) => indexer.lastConfirmedBlock)).toBe(BigInt(1000))
    }))

  it.effect("lastConfirmedBlock applies a confirmations override and never goes below 0", () =>
    Effect.gen(function*() {
      const fake = fakeRpc([health(1000), health(3)])
      expect(yield* run(fake, (indexer) => indexer.lastConfirmedBlock, { confirmations: 10 })).toBe(BigInt(990))
      expect(yield* run(fake, (indexer) => indexer.lastConfirmedBlock, { confirmations: 10 })).toBe(BigInt(0))
    }))

  it.effect("fetchEvents pages with the cursor, stops past toBlock and maps events", () =>
    Effect.gen(function*() {
      const fake = fakeRpc([
        health(1000),
        events([rawEvent(100, 0), rawEvent(100, 1)], "cursor-1"),
        events([rawEvent(101, 0), rawEvent(150, 0)], "cursor-2"),
        events([rawEvent(150, 1), rawEvent(201, 0)], "cursor-3")
      ])
      const result = yield* fetchEvents(fake, 100, 200, { limit: 2 })

      expect(result.map((e) => e.id)).toStrictEqual(
        [rawEvent(100, 0), rawEvent(100, 1), rawEvent(101, 0), rawEvent(150, 0), rawEvent(150, 1)].map((e) => e.id)
      )
      expect(result[1]).toStrictEqual({
        id: rawEvent(100, 1).id,
        contractId: address,
        topics: ["AAAADwAAAAh0cmFuc2Zlcg=="],
        value: "AAAACgAAAAAAAAAAAAAAAAAAASw=",
        blockNumber: BigInt(100),
        transactionHash: `0x${txHash}`,
        eventIndex: 1,
        ledgerClosedAt: "2026-07-21T20:44:01Z"
      })
      expect(fake.requests.map((r) => r.params)).toStrictEqual([
        null,
        { filters, pagination: { limit: 2 }, startLedger: 100, endLedger: 201 },
        { filters, pagination: { limit: 2, cursor: "cursor-1" } },
        { filters, pagination: { limit: 2, cursor: "cursor-2" } }
      ])
    }))

  it.effect("fetchEvents drops events from failed contract calls", () =>
    Effect.gen(function*() {
      const fake = fakeRpc([
        health(1000),
        events([rawEvent(100, 0, { inSuccessfulContractCall: false }), rawEvent(100, 1)])
      ])
      expect((yield* fetchEvents(fake, 100, 200)).map((e) => e.eventIndex)).toStrictEqual([1])
    }))

  it.effect("fetchEvents returns nothing for an empty range without calling the RPC", () =>
    Effect.gen(function*() {
      const fake = fakeRpc([])
      expect(yield* fetchEvents(fake, 200, 100)).toStrictEqual([])
      expect(fake.requests).toStrictEqual([])
    }))

  it.effect("fetchEvents fails when fromBlock is older than the RPC retention window", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(fetchEvents(fakeRpc([health(1000, 500)]), 100, 200))
      expect(error._tag).toBe("StellarIndexerError")
      expect(error.reason).toContain("oldest retained ledger 500")
    }))

  it.effect("maps JSON-RPC errors to StellarIndexerError without retrying", () =>
    Effect.gen(function*() {
      const fake = fakeRpc([health(1000), { error: { code: -32600, message: "boom" } }])
      const error = yield* Effect.flip(fetchEvents(fake, 100, 200))
      expect(error.reason).toBe("failed to get events")
      expect(error.cause).toStrictEqual({ code: -32600, message: "boom" })
      expect(fake.requests).toHaveLength(2)
    }))

  it.effect("retries HTTP 429 responses", () =>
    Effect.gen(function*() {
      const fake = fakeRpc([{ status: 429 }, { status: 429 }, health(1000)])
      const fiber = yield* Effect.forkChild(run(fake, (indexer) => indexer.lastConfirmedBlock))
      yield* TestClock.adjust("1 minute")
      expect(yield* Fiber.join(fiber)).toBe(BigInt(1000))
      expect(fake.requests).toHaveLength(3)
    }))

  it.effect("does not retry other HTTP errors", () =>
    Effect.gen(function*() {
      const fake = fakeRpc([{ status: 500 }])
      const error = yield* Effect.flip(run(fake, (indexer) => indexer.lastConfirmedBlock))
      expect(error.reason).toBe("failed to get the latest ledger")
      expect(fake.requests).toHaveLength(1)
    }))
})
