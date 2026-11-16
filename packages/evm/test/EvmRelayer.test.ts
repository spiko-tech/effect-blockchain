import * as Replay from "@effect-blockchain/core/test/utils/replay"
import * as EvmRelayer from "@effect-blockchain/evm/EvmRelayer"
import * as EvmRpc from "@effect-blockchain/evm/EvmRpc"
import { EvmTransaction, EvmTransactionReceipt } from "@effect-blockchain/evm/EvmTransaction"
import { EvmTransactionHash } from "@effect-blockchain/evm/EvmTransactionHash"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as TestClock from "effect/testing/TestClock"

const HASH = EvmTransactionHash.make("0x" + "cd".repeat(32))
const ADDRESS = "0x" + "11".repeat(20)

const pending = Schema.decodeUnknownSync(EvmTransaction)({
  hash: HASH,
  from: ADDRESS,
  to: ADDRESS,
  nonce: "0x0",
  value: "0x0",
  input: "0x",
  gas: "0x5208",
  blockNumber: null,
  blockHash: null,
  transactionIndex: null
})

const receipt = (block: number, status = 1) =>
  Schema.decodeUnknownSync(EvmTransactionReceipt)({
    transactionHash: HASH,
    transactionIndex: "0x0",
    blockNumber: `0x${block.toString(16)}`,
    blockHash: "0x" + "ab".repeat(32),
    from: ADDRESS,
    to: ADDRESS,
    status: `0x${status}`,
    gasUsed: "0x5208",
    effectiveGasPrice: "0x1",
    logs: []
  })

interface Node {
  readonly head: number
  readonly transaction?: EvmTransaction | undefined
  readonly receipt?: EvmTransactionReceipt | undefined
}

// a fake service answering from `node.current`, which a test replaces between polls
const setup = (initial: Node, options?: Parameters<typeof EvmRelayer.layer>[0]) => {
  const node = { current: initial, polls: 0 }
  const rpc = Layer.succeed(
    EvmRpc.EvmRpc,
    EvmRpc.EvmRpc.of({
      network: "Ethereum",
      chainId: Effect.die("unused"),
      blockNumber: Effect.sync(() => BigInt(node.current.head)),
      getBlockByNumber: () => Effect.die("unused"),
      getBalance: () => Effect.die("unused"),
      getLogs: () => Effect.die("unused"),
      getTransactionByHash: () => Effect.sync(() => node.current.transaction ?? null),
      getTransactionReceipt: () =>
        Effect.sync(() => {
          node.polls++
          return node.current.receipt ?? null
        }),
      sendRawTransaction: () => Effect.die("unused"),
      getTransactionCount: () => Effect.die("unused"),
      estimateGas: () => Effect.die("unused"),
      feeHistory: () => Effect.die("unused")
    })
  )
  const run = <A, E>(f: (relayer: EvmRelayer.EvmRelayer["Service"]) => Effect.Effect<A, E>) =>
    Effect.gen(function*() {
      return yield* f(yield* EvmRelayer.EvmRelayer)
    }).pipe(Effect.provide(EvmRelayer.layer(options).pipe(Layer.provide(rpc))))
  return { node, run }
}

const statusOf = (node: Node, options?: Parameters<typeof EvmRelayer.layer>[0]) =>
  setup(node, options).run((relayer) => relayer.fetchTransactionStatus({ hash: HASH }))

describe("EvmRelayer", () => {
  it.effect("maps what the node knows to a status", () =>
    Effect.gen(function*() {
      // Ethereum confirms after 64 blocks: head 164 confirms block 100
      expect(yield* statusOf({ head: 164 })).toStrictEqual({ _tag: "NotFound" })
      expect(yield* statusOf({ head: 164, transaction: pending })).toStrictEqual({ _tag: "Pending" })
      expect(yield* statusOf({ head: 163, receipt: receipt(100) })).toStrictEqual({
        _tag: "Included",
        block: BigInt(100)
      })
      expect(yield* statusOf({ head: 164, receipt: receipt(100) })).toStrictEqual({
        _tag: "Confirmed",
        block: BigInt(100)
      })
    }))

  it.effect("reports a revert as Failed only once its block is confirmed", () =>
    Effect.gen(function*() {
      expect(yield* statusOf({ head: 163, receipt: receipt(100, 0) })).toStrictEqual({
        _tag: "Included",
        block: BigInt(100)
      })
      expect(yield* statusOf({ head: 164, receipt: receipt(100, 0) })).toStrictEqual({
        _tag: "Failed",
        block: BigInt(100),
        reason: undefined
      })
    }))

  it.effect("uses the confirmations option", () =>
    Effect.gen(function*() {
      expect((yield* statusOf({ head: 101, receipt: receipt(100) }, { confirmations: 2 }))._tag).toBe("Included")
      expect((yield* statusOf({ head: 102, receipt: receipt(100) }, { confirmations: 2 }))._tag).toBe("Confirmed")
    }))

  it.effect("awaitConfirmation polls every 10 seconds until the transaction is confirmed", () => {
    const { node, run } = setup({ head: 100 })
    return run((relayer) =>
      Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(relayer.awaitConfirmation({ hash: HASH }))
        yield* TestClock.adjust(0)
        expect(node.polls).toBe(1)
        node.current = { head: 100, transaction: pending }
        yield* TestClock.adjust("9 seconds")
        expect(node.polls).toBe(1)
        yield* TestClock.adjust("1 second")
        expect(node.polls).toBe(2)
        node.current = { head: 101, receipt: receipt(101) }
        yield* TestClock.adjust("10 seconds")
        expect(node.polls).toBe(3)
        expect(fiber.pollUnsafe()).toBeUndefined()
        node.current = { head: 165, receipt: receipt(101) }
        yield* TestClock.adjust("10 seconds")
        expect(yield* Fiber.join(fiber)).toStrictEqual({ _tag: "Confirmed", block: BigInt(101) })
        expect(node.polls).toBe(4)
      })
    )
  })

  it.effect("awaitConfirmation returns a confirmed revert, and the last status when poll ends first", () =>
    Effect.gen(function*() {
      const failed = setup({ head: 164, receipt: receipt(100, 0) })
      expect((yield* failed.run((relayer) => relayer.awaitConfirmation({ hash: HASH })))._tag).toBe("Failed")
      expect(failed.node.polls).toBe(1)
      const unknown = setup({ head: 164 })
      expect(
        yield* unknown.run((relayer) => relayer.awaitConfirmation({ hash: HASH, poll: Schedule.recurs(2) }))
      ).toStrictEqual({ _tag: "NotFound" })
      expect(unknown.node.polls).toBe(3)
    }))

  // the pinned transactions of `scripts/record-fixtures.ts`, both in block 26083549, far below the recorded head
  for (const provider of ["alchemy", "infura"]) {
    it.effect(`fixture: ${provider} status of a confirmed and of a reverted transaction`, () => {
      const { check, endpoints, fetch, served } = Replay.replay(new URL("fixtures/", import.meta.url), [{
        name: provider,
        cases: ["chainId", "blockNumber", "getTransactionReceipt", "getTransactionReceipt-reverted"]
      }])
      const layer = EvmRelayer.layer().pipe(
        Layer.provide(EvmRpc.layer({ network: "Ethereum", endpoints, retries: 0 })),
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))
      )
      return check(
        Effect.gen(function*() {
          const relayer = yield* EvmRelayer.EvmRelayer
          expect(
            yield* relayer.fetchTransactionStatus({
              hash: EvmTransactionHash.make("0x5b742dac0f3747de0d0196a04c4d821c8e086f06c4b98d024b08ae18ea39678e")
            })
          ).toStrictEqual({ _tag: "Confirmed", block: BigInt(26083549) })
          expect(
            yield* relayer.fetchTransactionStatus({
              hash: EvmTransactionHash.make("0x94bb947f04a680590b0c639820e7c7552521a26b2fa424824984be66e5bcc39c")
            })
          ).toStrictEqual({ _tag: "Failed", block: BigInt(26083549), reason: undefined })
          expect(served).toStrictEqual([
            `${provider} chainId`,
            `${provider} getTransactionReceipt`,
            `${provider} blockNumber`,
            `${provider} getTransactionReceipt-reverted`,
            `${provider} blockNumber`
          ])
        }).pipe(Effect.provide(layer))
      )
    })
  }
})
