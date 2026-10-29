import { StarknetAddress } from "@effect-blockchain/starknet/StarknetAddress"
import * as StarknetIndexer from "@effect-blockchain/starknet/StarknetIndexer"
import { defaultConfirmations } from "@effect-blockchain/starknet/StarknetNetwork"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"

const address = StarknetAddress.make("0x0000000000000000000000000000000000000000000000000000000000000abc")
const felt = (n: number) => `0x${n.toString(16).padStart(64, "0")}`

interface Call {
  readonly method: string
  readonly params: any
}

// Answers each JSON-RPC call with the next response for its method: a result, `{ error }` or `{ status }`
const fakeFetch = (responses: Record<string, Array<unknown>>) => {
  const calls: Array<Call> = []
  const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    const { id, method, params } = JSON.parse(init!.body as string)
    calls.push({ method, params })
    const next = responses[method]!.shift() as any
    if (next?.status !== undefined) return new Response("Too Many Requests", { status: next.status })
    const body = next?.error !== undefined
      ? { jsonrpc: "2.0", id, error: next.error }
      : { jsonrpc: "2.0", id, result: next }
    return new Response(JSON.stringify(body))
  }
  return { calls, fetch: fetch as typeof globalThis.fetch }
}

const indexer = (fetch: typeof globalThis.fetch, options: { confirmations?: number; chunkSize?: number } = {}) =>
  StarknetIndexer.layer({ network: "Starknet", rpcUrl: "http://rpc.test", fetch, ...options })

const run = <A, E>(
  effect: Effect.Effect<A, E, StarknetIndexer.StarknetIndexer>,
  layer: Layer.Layer<StarknetIndexer.StarknetIndexer>
) => Effect.provide(effect, layer)

const rpcEvent = (block: number, tx: number, key: number, extra: object = {}) => ({
  from_address: "0xabc",
  keys: [felt(key)],
  data: ["0x1"],
  block_hash: "0x1",
  block_number: block,
  transaction_hash: felt(tx),
  ...extra
})

const fetchEvents = (fromBlock: number, toBlock: number) =>
  StarknetIndexer.StarknetIndexer.use((s) =>
    s.fetchEvents({ address, fromBlock: BigInt(fromBlock), toBlock: BigInt(toBlock) })
  )

const lastConfirmedBlock = StarknetIndexer.StarknetIndexer.use((s) => s.lastConfirmedBlock)

describe("StarknetIndexer", () => {
  it.effect("lastConfirmedBlock uses the network default confirmations", () =>
    Effect.gen(function*() {
      const { fetch } = fakeFetch({ starknet_blockNumber: [100] })
      expect(yield* run(lastConfirmedBlock, indexer(fetch))).toBe(BigInt(100 - defaultConfirmations("Starknet")))
    }))

  it.effect("lastConfirmedBlock applies the confirmations override, never below 0", () =>
    Effect.gen(function*() {
      const { fetch } = fakeFetch({ starknet_blockNumber: [100, 3] })
      const layer = indexer(fetch, { confirmations: 5 })
      expect(yield* run(lastConfirmedBlock, layer)).toBe(BigInt(95))
      expect(yield* run(lastConfirmedBlock, layer)).toBe(BigInt(0))
    }))

  it.effect("pages with the continuation token and keeps order", () =>
    Effect.gen(function*() {
      const { calls, fetch } = fakeFetch({
        starknet_getEvents: [
          {
            events: [rpcEvent(10, 1, 1, { event_index: 0 }), rpcEvent(10, 1, 2, { event_index: 3 })],
            continuation_token: "p2"
          },
          { events: [rpcEvent(12, 2, 3, { event_index: 1 })] }
        ]
      })
      const events = yield* run(fetchEvents(10, 12), indexer(fetch, { chunkSize: 2 }))
      expect(events.map((e) => [e.blockNumber, e.keys[0], e.eventIndex])).toStrictEqual([
        [BigInt(10), felt(1), 0],
        [BigInt(10), felt(2), 3],
        [BigInt(12), felt(3), 1]
      ])
      expect(events[0]).toStrictEqual({
        fromAddress: address,
        keys: [felt(1)],
        data: [felt(1)],
        blockNumber: BigInt(10),
        transactionHash: felt(1),
        eventIndex: 0
      })
      expect(calls.map((c) => c.params.filter)).toStrictEqual([
        { address, from_block: { block_number: 10 }, to_block: { block_number: 12 }, chunk_size: 2 },
        {
          address,
          from_block: { block_number: 10 },
          to_block: { block_number: 12 },
          chunk_size: 2,
          continuation_token: "p2"
        }
      ])
    }))

  it.effect("derives the event index from one receipt per transaction", () =>
    Effect.gen(function*() {
      const other = { from_address: felt(0xdef), keys: [felt(9)], data: [] }
      const ours = { from_address: address, keys: [felt(1)], data: ["0x1"] }
      const { calls, fetch } = fakeFetch({
        starknet_getEvents: [{
          events: [rpcEvent(10, 1, 1), rpcEvent(10, 1, 1), { ...rpcEvent(11, 2, 1), block_number: undefined }]
        }],
        starknet_getTransactionReceipt: [{ events: [other, ours, other, ours] }]
      })
      const events = yield* run(fetchEvents(10, 11), indexer(fetch))
      expect(events.map((e) => e.eventIndex)).toStrictEqual([1, 3])
      expect(calls.filter((c) => c.method === "starknet_getTransactionReceipt")).toHaveLength(1)
    }))

  it.effect("returns nothing for an empty or inverted range", () =>
    Effect.gen(function*() {
      const { calls, fetch } = fakeFetch({ starknet_getEvents: [{ events: [] }] })
      expect(yield* run(fetchEvents(10, 12), indexer(fetch))).toStrictEqual([])
      expect(yield* run(fetchEvents(12, 10), indexer(fetch))).toStrictEqual([])
      expect(calls).toHaveLength(1)
    }))

  it.effect("maps RPC errors without retrying", () =>
    Effect.gen(function*() {
      const { calls, fetch } = fakeFetch({
        starknet_blockNumber: [{ error: { code: 24, message: "Block not found" } }]
      })
      const error = yield* Effect.flip(run(lastConfirmedBlock, indexer(fetch)))
      expect(error._tag).toBe("StarknetIndexerError")
      expect(error.reason).toBe("starknet_blockNumber: RPC error 24")
      expect(calls).toHaveLength(1)
    }))

  it.effect("maps malformed results", () =>
    Effect.gen(function*() {
      const { fetch } = fakeFetch({ starknet_getEvents: [{ events: [{ from_address: "nope" }] }] })
      const error = yield* Effect.flip(run(fetchEvents(1, 2), indexer(fetch)))
      expect(error.reason).toBe("starknet_getEvents: unexpected result")
    }))

  it.live("retries on HTTP 429", () =>
    Effect.gen(function*() {
      const { calls, fetch } = fakeFetch({ starknet_blockNumber: [{ status: 429 }, 7] })
      expect(yield* run(lastConfirmedBlock, indexer(fetch))).toBe(BigInt(7))
      expect(calls).toHaveLength(2)
    }))

  it.effect("does not retry other HTTP errors", () =>
    Effect.gen(function*() {
      const { calls, fetch } = fakeFetch({ starknet_blockNumber: [{ status: 500 }] })
      const error = yield* Effect.flip(run(lastConfirmedBlock, indexer(fetch)))
      expect(error.reason).toBe("starknet_blockNumber: HTTP 500")
      expect(calls).toHaveLength(1)
    }))
})
