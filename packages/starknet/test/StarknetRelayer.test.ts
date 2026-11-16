import * as StarknetRelayer from "@effect-blockchain/starknet/StarknetRelayer"
import * as StarknetRpc from "@effect-blockchain/starknet/StarknetRpc"
import { StarknetTransactionHash } from "@effect-blockchain/starknet/StarknetTransactionHash"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Schedule from "effect/Schedule"
import * as TestClock from "effect/testing/TestClock"

const HASH = StarknetTransactionHash.make("0x" + "cd".repeat(32))

type Finality = StarknetRpc.StarknetTransactionStatusResult["finalityStatus"]

interface Node {
  readonly head: number
  readonly status?: StarknetRpc.StarknetTransactionStatusResult | undefined
  // the block of the receipt, a missing one answers `TXN_HASH_NOT_FOUND`
  readonly block?: number | undefined
}

const accepted = (
  block: number,
  finalityStatus: Finality = "ACCEPTED_ON_L2"
): Pick<Node, "status" | "block"> => ({ status: { finalityStatus, executionStatus: "SUCCEEDED" }, block })

const reverted = (block: number): Pick<Node, "status" | "block"> => ({
  status: { finalityStatus: "ACCEPTED_ON_L2", executionStatus: "REVERTED", failureReason: "out of gas" },
  block
})

// a fake service answering from `node.current`, which a test replaces between polls
const setup = (initial: Node, options?: Parameters<typeof StarknetRelayer.layer>[0]) => {
  const node = { current: initial, polls: 0 }
  const rpc = Layer.succeed(
    StarknetRpc.StarknetRpc,
    StarknetRpc.StarknetRpc.of({
      network: "Starknet",
      chainId: Effect.die("unused"),
      blockNumber: Effect.sync(() => BigInt(node.current.head)),
      getBlockWithTxHashes: () => Effect.die("unused"),
      getEvents: () => Effect.die("unused"),
      call: () => Effect.die("unused"),
      getTransactionStatus: () =>
        Effect.sync(() => {
          node.polls++
          return node.current.status ?? null
        }),
      getTransactionReceipt: ({ transactionHash }) =>
        Effect.suspend(() =>
          node.current.block === undefined
            ? Effect.die("no receipt")
            : Effect.succeed({
              transactionHash,
              blockNumber: BigInt(node.current.block),
              blockHash: "0x" + "ab".repeat(32),
              events: []
            })
        )
    })
  )
  const run = <A, E>(f: (relayer: StarknetRelayer.StarknetRelayer["Service"]) => Effect.Effect<A, E>) =>
    Effect.gen(function*() {
      return yield* f(yield* StarknetRelayer.StarknetRelayer)
    }).pipe(Effect.provide(StarknetRelayer.layer(options).pipe(Layer.provide(rpc))))
  return { node, run }
}

const statusOf = (node: Node, options?: Parameters<typeof StarknetRelayer.layer>[0]) =>
  setup(node, options).run((relayer) => relayer.fetchTransactionStatus({ hash: HASH }))

describe("StarknetRelayer", () => {
  it.effect("maps what the node knows to a status", () =>
    Effect.gen(function*() {
      expect(yield* statusOf({ head: 100 })).toStrictEqual({ _tag: "NotFound" })
      // not in an accepted block: the receipt is not read
      for (const finalityStatus of ["RECEIVED", "CANDIDATE", "PRE_CONFIRMED"] as const) {
        expect(yield* statusOf({ head: 100, status: { finalityStatus } })).toStrictEqual({ _tag: "Pending" })
      }
      // Starknet confirms an accepted block at once: a head at the block confirms it, a head read behind does not
      expect(yield* statusOf({ head: 99, ...accepted(100) })).toStrictEqual({ _tag: "Included", block: BigInt(100) })
      expect(yield* statusOf({ head: 100, ...accepted(100) })).toStrictEqual({ _tag: "Confirmed", block: BigInt(100) })
      expect(yield* statusOf({ head: 100, ...accepted(100, "ACCEPTED_ON_L1") })).toStrictEqual({
        _tag: "Confirmed",
        block: BigInt(100)
      })
    }))

  it.effect("reports a revert as Failed only once its block is confirmed", () =>
    Effect.gen(function*() {
      expect(yield* statusOf({ head: 99, ...reverted(100) })).toStrictEqual({ _tag: "Included", block: BigInt(100) })
      expect(yield* statusOf({ head: 100, ...reverted(100) })).toStrictEqual({
        _tag: "Failed",
        block: BigInt(100),
        reason: "out of gas"
      })
      expect(
        yield* statusOf({
          head: 100,
          status: { finalityStatus: "ACCEPTED_ON_L2", executionStatus: "REVERTED" },
          block: 100
        })
      ).toStrictEqual({ _tag: "Failed", block: BigInt(100), reason: undefined })
    }))

  it.effect("uses the confirmations option, also for a block accepted on L1", () =>
    Effect.gen(function*() {
      const options = { confirmations: 2 }
      expect((yield* statusOf({ head: 101, ...accepted(100) }, options))._tag).toBe("Included")
      expect((yield* statusOf({ head: 101, ...accepted(100, "ACCEPTED_ON_L1") }, options))._tag).toBe("Included")
      expect((yield* statusOf({ head: 102, ...accepted(100) }, options))._tag).toBe("Confirmed")
    }))

  it.effect("awaitConfirmation polls every 10 seconds until the transaction is confirmed", () => {
    const { node, run } = setup({ head: 100 })
    return run((relayer) =>
      Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(relayer.awaitConfirmation({ hash: HASH }))
        yield* TestClock.adjust(0)
        expect(node.polls).toBe(1)
        node.current = { head: 100, status: { finalityStatus: "RECEIVED" } }
        yield* TestClock.adjust("9 seconds")
        expect(node.polls).toBe(1)
        yield* TestClock.adjust("1 second")
        expect(node.polls).toBe(2)
        node.current = { head: 100, ...accepted(101) }
        yield* TestClock.adjust("10 seconds")
        expect(node.polls).toBe(3)
        expect(fiber.pollUnsafe()).toBeUndefined()
        node.current = { head: 101, ...accepted(101) }
        yield* TestClock.adjust("10 seconds")
        expect(yield* Fiber.join(fiber)).toStrictEqual({ _tag: "Confirmed", block: BigInt(101) })
        expect(node.polls).toBe(4)
      })
    )
  })

  it.effect("awaitConfirmation returns a confirmed revert, and the last status when poll ends first", () =>
    Effect.gen(function*() {
      const failed = setup({ head: 100, ...reverted(100) })
      expect((yield* failed.run((relayer) => relayer.awaitConfirmation({ hash: HASH })))._tag).toBe("Failed")
      expect(failed.node.polls).toBe(1)
      const unknown = setup({ head: 100 })
      expect(
        yield* unknown.run((relayer) => relayer.awaitConfirmation({ hash: HASH, poll: Schedule.recurs(2) }))
      ).toStrictEqual({ _tag: "NotFound" })
      expect(unknown.node.polls).toBe(3)
    }))
})
