import { SYSTEM_PROGRAM_ADDRESS } from "@effect-blockchain/solana/SolanaAddress"
import { layer, SolanaIndexer } from "@effect-blockchain/solana/SolanaIndexer"
import { assert, describe, it } from "@effect/vitest"
import { getBase58Decoder } from "@solana/kit"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import { TestClock } from "effect/testing"
import { vi } from "vitest"

type Handler = (method: string, params: Array<any>) => unknown

// Tests run concurrently: each fake RPC gets its own URL, served by one stubbed `fetch`.
const handlers = new Map<string, Handler>()
vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
  const { id, method, params } = JSON.parse(init.body)
  const result = handlers.get(url)!(method, params)
  // A handler returning a Response is sent as-is (HTTP errors).
  return result instanceof Response ? result : new Response(JSON.stringify({ jsonrpc: "2.0", id, result }))
})

const stubRpc = (handler: Handler) => {
  const rpcUrl = `http://rpc-${handlers.size}.test`
  const calls: Array<{ method: string; params: Array<any> }> = []
  handlers.set(rpcUrl, (method, params) => {
    calls.push({ method, params })
    return handler(method, params)
  })
  return { rpcUrl, calls }
}

const signatureOf = (n: number) => {
  const bytes = new Uint8Array(64).fill(7)
  bytes[0] = 1 + (n % 200)
  bytes[1] = 1 + Math.floor(n / 200)
  return getBase58Decoder().decode(bytes)
}

const sig = (n: number, slot: number, err: unknown = null) => ({
  signature: signatureOf(n),
  slot,
  err,
  blockTime: 1_700_000_000,
  memo: null,
  confirmationStatus: "confirmed"
})

const transactionOf = (signature: string) => ({
  slot: 0,
  blockTime: 1_700_000_000,
  transaction: [`tx:${signature}`, "base64"],
  meta: { fee: 5000, err: null, logMessages: [] },
  version: 0
})

const run = <A, E>(
  rpcUrl: string,
  effect: (indexer: SolanaIndexer["Service"]) => Effect.Effect<A, E>,
  confirmations?: number
) =>
  Effect.gen(function*() {
    return yield* effect(yield* SolanaIndexer)
  }).pipe(
    Effect.provide(layer({ network: "Solana", rpcUrl, confirmations }))
  )

const range = { address: SYSTEM_PROGRAM_ADDRESS, fromBlock: BigInt(50), toBlock: BigInt(100) }

describe("SolanaIndexer", () => {
  it.effect("lastConfirmedBlock subtracts the default confirmations", () =>
    Effect.gen(function*() {
      const { calls, rpcUrl } = stubRpc(() => 1000)
      assert.strictEqual(yield* run(rpcUrl, (indexer) => indexer.lastConfirmedBlock), BigInt(968))
      assert.deepStrictEqual(calls[0], { method: "getSlot", params: [{ commitment: "confirmed" }] })
    }))

  it.effect("lastConfirmedBlock honours an override and never goes below 0", () =>
    Effect.gen(function*() {
      const head = stubRpc(() => 1000)
      assert.strictEqual(yield* run(head.rpcUrl, (indexer) => indexer.lastConfirmedBlock, 5), BigInt(995))
      const early = stubRpc(() => 10)
      assert.strictEqual(yield* run(early.rpcUrl, (indexer) => indexer.lastConfirmedBlock), BigInt(0))
    }))

  it.effect("pages signatures, keeps failed transactions and orders by (slot, index)", () =>
    Effect.gen(function*() {
      // Newest first: one entry above the range, 999 in slot 100, then a short page reaching below the range.
      const page1 = [sig(0, 101), ...Array.from({ length: 999 }, (_, i) => sig(i + 1, 100))]
      const page2 = [sig(1000, 60, { InstructionError: [0, "Custom"] }), sig(1001, 60), sig(1002, 40)]
      const { calls, rpcUrl } = stubRpc((method, params) => {
        if (method === "getTransaction") return transactionOf(params[0])
        return params[1].before === undefined ? page1 : page2
      })

      const txs = yield* run(rpcUrl, (indexer) => indexer.fetchTransactions(range))

      const signatureCalls = calls.filter((c) => c.method === "getSignaturesForAddress")
      assert.strictEqual(signatureCalls.length, 2)
      assert.strictEqual(signatureCalls[1].params[1].before, page1[999].signature)
      assert.strictEqual(txs.length, 1001)
      assert.deepStrictEqual(txs[0], {
        signature: signatureOf(1001) as any,
        blockNumber: BigInt(60),
        blockTime: BigInt(1_700_000_000),
        index: 0,
        err: false,
        transaction: `tx:${signatureOf(1001)}`,
        meta: { fee: "5000", err: null, logMessages: [] }
      })
      assert.deepStrictEqual(txs.slice(1, 3).map((tx) => [tx.blockNumber, tx.index, tx.err]), [
        [BigInt(60), 1, true],
        [BigInt(100), 0, false]
      ])
      assert.strictEqual(txs[1000].signature, signatureOf(1))
      assert.strictEqual(txs[1000].index, 998)
      const getTransaction = calls.find((c) => c.method === "getTransaction")
      assert.deepStrictEqual(getTransaction?.params[1], {
        encoding: "base64",
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed"
      })
    }))

  it.effect("returns nothing for an empty range", () =>
    Effect.gen(function*() {
      const { rpcUrl } = stubRpc(() => [])
      assert.deepStrictEqual(yield* run(rpcUrl, (indexer) => indexer.fetchTransactions(range)), [])
    }))

  it.effect("maps RPC failures to SolanaIndexerError", () =>
    Effect.gen(function*() {
      const { calls, rpcUrl } = stubRpc(() => new Response("boom", { status: 500 }))
      const error = yield* Effect.flip(run(rpcUrl, (indexer) => indexer.lastConfirmedBlock))
      assert.strictEqual(error._tag, "SolanaIndexerError")
      assert.strictEqual(error.reason, "SolanaIndexer.lastConfirmedBlock: failed to get slot")
      assert.strictEqual(calls.length, 1)
    }))

  it.effect("fails when a listed transaction is missing", () =>
    Effect.gen(function*() {
      const { rpcUrl } = stubRpc((method) => method === "getTransaction" ? null : [sig(0, 70)])
      const error = yield* Effect.flip(run(rpcUrl, (indexer) => indexer.fetchTransactions(range)))
      assert.strictEqual(error.reason, `SolanaIndexer.fetchTransactions: transaction ${signatureOf(0)} not found`)
    }))

  it.effect("retries on HTTP 429", () =>
    Effect.gen(function*() {
      let attempts = 0
      const { rpcUrl } = stubRpc(() => ++attempts < 3 ? new Response("slow down", { status: 429 }) : 1000)
      const fiber = yield* Effect.forkChild(run(rpcUrl, (indexer) => indexer.lastConfirmedBlock))
      // Let each fake fetch settle before moving the clock past the backoff.
      for (let i = 0; i < 4; i++) {
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 5)))
        yield* TestClock.adjust("10 seconds")
      }
      assert.strictEqual(yield* Fiber.join(fiber), BigInt(968))
      assert.strictEqual(attempts, 3)
    }))
})
