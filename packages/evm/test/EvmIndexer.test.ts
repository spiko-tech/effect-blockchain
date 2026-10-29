import { EvmAddress } from "@effect-blockchain/evm/EvmAddress"
import { EvmIndexer, layer } from "@effect-blockchain/evm/EvmIndexer"
import { defaultConfirmations } from "@effect-blockchain/evm/EvmNetwork"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { vi } from "vitest"

type RpcRequest = { readonly method: string; readonly params: ReadonlyArray<any> }
type Handler = (request: RpcRequest) => Response | unknown

// one fake JSON-RPC endpoint per test URL, since tests in this file run concurrently
const handlers = new Map<string, Handler>()
vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
  const { id, method, params } = JSON.parse(init.body as string)
  const result = handlers.get(url)!({ method, params })
  return result instanceof Response ? result : Response.json({ jsonrpc: "2.0", id, result })
})

const endpoint = (name: string, handler: Handler) => {
  const url = `https://rpc.test/${name}/secret-api-key`
  handlers.set(url, handler)
  return url
}

const address = Schema.decodeSync(EvmAddress)("0xb794f5ea0ba39494ce839613fffba74279579268")
const hex = (n: number | bigint) => `0x${n.toString(16)}`
const rpcLog = (blockNumber: bigint, logIndex: number) => ({
  address,
  topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"],
  data: "0x",
  blockNumber: hex(blockNumber),
  blockHash: `0x${"ab".repeat(32)}`,
  transactionHash: `0x${"cd".repeat(32)}`,
  transactionIndex: "0x0",
  logIndex: hex(logIndex),
  removed: false
})

describe("EvmIndexer", () => {
  it.effect("lastConfirmedBlock subtracts the network default confirmations", () =>
    EvmIndexer.use((indexer) => indexer.lastConfirmedBlock).pipe(
      Effect.map((block) => expect(block).toBe(BigInt(1000 - defaultConfirmations("Ethereum")))),
      Effect.provide(layer({ network: "Ethereum", rpcUrl: endpoint("head", () => hex(1000)) }))
    ))

  it.effect("lastConfirmedBlock uses the confirmations override and never goes below 0", () =>
    Effect.gen(function*() {
      const rpcUrl = endpoint("override", () => hex(1000))
      const override = EvmIndexer.use((indexer) => indexer.lastConfirmedBlock)
      expect(yield* override.pipe(Effect.provide(layer({ network: "Ethereum", rpcUrl, confirmations: 3 })))).toBe(
        997n
      )
      expect(yield* override.pipe(Effect.provide(layer({ network: "Ethereum", rpcUrl, confirmations: 5000 })))).toBe(
        0n
      )
    }))

  it.effect("fetchLogs splits the range into chunks and orders logs by block then index", () => {
    const calls: Array<ReadonlyArray<unknown>> = []
    const rpcUrl = endpoint("chunks", ({ params: [{ fromBlock, toBlock }] }) => {
      calls.push([fromBlock, toBlock])
      return fromBlock === "0x0" ? [rpcLog(9n, 1), rpcLog(9n, 0)] : fromBlock === "0xa" ? [] : [rpcLog(20n, 4)]
    })
    return EvmIndexer.use((indexer) => indexer.fetchLogs({ address, fromBlock: 0n, toBlock: 24n })).pipe(
      Effect.map((logs) => {
        expect(calls).toStrictEqual([["0x0", "0x9"], ["0xa", "0x13"], ["0x14", "0x18"]])
        expect(logs.map((log) => [log.blockNumber, log.logIndex])).toStrictEqual([[9n, 0], [9n, 1], [20n, 4]])
        expect(logs[0]).toStrictEqual({
          address,
          topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"],
          data: "0x",
          blockNumber: 9n,
          blockHash: `0x${"ab".repeat(32)}`,
          transactionHash: `0x${"cd".repeat(32)}`,
          logIndex: 0
        })
      }),
      Effect.provide(layer({ network: "Base", rpcUrl, maxBlockRange: 10 }))
    )
  })

  it.effect("fetchLogs returns nothing for an empty range without calling the RPC", () =>
    EvmIndexer.use((indexer) => indexer.fetchLogs({ address, fromBlock: 5n, toBlock: 4n })).pipe(
      Effect.map((logs) => expect(logs).toStrictEqual([])),
      Effect.provide(layer({ network: "Base", rpcUrl: endpoint("empty", () => expect.unreachable()) }))
    ))

  it.effect("maps RPC failures to EvmIndexerError with the RPC URL redacted", () =>
    EvmIndexer.use((indexer) => indexer.lastConfirmedBlock).pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error._tag).toBe("EvmIndexerError")
        expect(error.reason).toBe("EvmIndexer.lastConfirmedBlock: failed to get block number")
        const message = (error.cause as Error).message
        expect(message).toContain("https://rpc.test/[REDACTED]")
        expect(message).not.toContain("secret-api-key")
      }),
      Effect.provide(layer({
        network: "Ethereum",
        rpcUrl: endpoint("failure", () => new Response("boom", { status: 500 }))
      }))
    ))

  it.effect("fails on removed and pending logs", () =>
    Effect.gen(function*() {
      const fetchLogs = EvmIndexer.use((indexer) => indexer.fetchLogs({ address, fromBlock: 0n, toBlock: 0n }))
      const removed = endpoint("removed", () => [{ ...rpcLog(0n, 0), removed: true }])
      const pending = endpoint("pending", () => [{ ...rpcLog(0n, 0), blockNumber: null, transactionHash: null }])
      const removedError = yield* fetchLogs.pipe(
        Effect.flip,
        Effect.provide(layer({ network: "Base", rpcUrl: removed }))
      )
      expect(removedError.reason).toBe("EvmIndexer.fetchLogs: log removed by a reorg")
      const pendingError = yield* fetchLogs.pipe(
        Effect.flip,
        Effect.provide(layer({ network: "Base", rpcUrl: pending }))
      )
      expect(pendingError.reason).toBe("EvmIndexer.fetchLogs: invalid or pending log")
    }))

  it.live("retries on HTTP 429", () => {
    let calls = 0
    const rpcUrl = endpoint("rate-limited", () => ++calls === 1 ? new Response("slow down", { status: 429 }) : hex(10))
    return EvmIndexer.use((indexer) => indexer.lastConfirmedBlock).pipe(
      Effect.map((block) => {
        expect(block).toBe(7n)
        expect(calls).toBe(2)
      }),
      Effect.provide(layer({ network: "Ethereum", rpcUrl, confirmations: 3 }))
    )
  })

  it.effect("does not retry other HTTP errors", () => {
    let calls = 0
    const rpcUrl = endpoint("no-retry", () => (++calls, new Response("boom", { status: 503 })))
    return EvmIndexer.use((indexer) => indexer.lastConfirmedBlock).pipe(
      Effect.flip,
      Effect.map(() => expect(calls).toBe(1)),
      Effect.provide(layer({ network: "Ethereum", rpcUrl }))
    )
  })
})
