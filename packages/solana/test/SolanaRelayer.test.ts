import * as SolanaRelayer from "@effect-blockchain/solana/SolanaRelayer"
import * as SolanaRpc from "@effect-blockchain/solana/SolanaRpc"
import { SolanaTransactionHash } from "@effect-blockchain/solana/SolanaTransactionHash"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Schedule from "effect/Schedule"
import * as TestClock from "effect/testing/TestClock"

const HASH = SolanaTransactionHash.make(
  "2ijR446DGZ3zFMDdp5JrbonSpRwrvN4bGK7oGiLpn5DpR9eCFHZjMPh89feRiuygcVhhY6HxP64y5xtnVfKJutz1"
)
const ERR = { InstructionError: [1, { Custom: 30 }] } as const

const status = (
  slot: number,
  confirmationStatus: SolanaRpc.SolanaSignatureStatus["confirmationStatus"] = "finalized",
  err: SolanaRpc.SolanaTransactionError | null = null
): SolanaRpc.SolanaSignatureStatus => ({
  slot: BigInt(slot),
  confirmations: confirmationStatus === "finalized" ? null : 1,
  err,
  confirmationStatus
})

interface Node {
  // the finalized slot
  readonly head: number
  // the finalized block height
  readonly height?: number | undefined
  readonly status?: SolanaRpc.SolanaSignatureStatus | undefined
}

// a fake service answering from `node.current`, which a test replaces between polls
const setup = (initial: Node, options?: Parameters<typeof SolanaRelayer.layer>[0]) => {
  const node: { current: Node; polls: number; calls: ReadonlyArray<string> } = { current: initial, polls: 0, calls: [] }
  const call = <A>(name: string, answer: () => A) =>
    Effect.sync(() => {
      node.calls = [...node.calls, name]
      return answer()
    })
  const rpc = Layer.succeed(
    SolanaRpc.SolanaRpc,
    SolanaRpc.SolanaRpc.of({
      network: "Solana",
      getGenesisHash: Effect.die("unused"),
      getSlot: () => call("getSlot", () => BigInt(node.current.head)),
      getBlockHeight: () => call("getBlockHeight", () => BigInt(node.current.height ?? 0)),
      getSignatureStatuses: ({ searchTransactionHistory, signatures }) =>
        call("getSignatureStatuses", () => {
          node.polls++
          expect(signatures).toStrictEqual([HASH])
          expect(searchTransactionHistory).toBe(true)
          return { slot: BigInt(node.current.head), value: [node.current.status ?? null] }
        }),
      getBalance: () => Effect.die("unused"),
      getSignaturesForAddress: () => Effect.die("unused"),
      getTransaction: () => Effect.die("unused")
    })
  )
  const run = <A, E>(f: (relayer: SolanaRelayer.SolanaRelayer["Service"]) => Effect.Effect<A, E>) =>
    Effect.gen(function*() {
      return yield* f(yield* SolanaRelayer.SolanaRelayer)
    }).pipe(Effect.provide(SolanaRelayer.layer(options).pipe(Layer.provide(rpc))))
  return { node, run }
}

const statusOf = (
  node: Node,
  options?: Parameters<typeof SolanaRelayer.layer>[0],
  lastValidBlockHeight?: number
) =>
  setup(node, options).run((relayer) =>
    relayer.fetchTransactionStatus({
      hash: HASH,
      lastValidBlockHeight: lastValidBlockHeight === undefined ? undefined : BigInt(lastValidBlockHeight)
    })
  )

describe("SolanaRelayer", () => {
  it.effect("maps what the node knows to a status", () =>
    Effect.gen(function*() {
      const included = { _tag: "Included", block: BigInt(100) }
      expect(yield* statusOf({ head: 100 })).toStrictEqual({ _tag: "NotFound" })
      expect(yield* statusOf({ head: 100, status: status(100, "processed") })).toStrictEqual(included)
      expect(yield* statusOf({ head: 100, status: status(100, "confirmed") })).toStrictEqual(included)
      expect(yield* statusOf({ head: 100, status: status(100, null) })).toStrictEqual(included)
      // an endpoint whose finalized slot is behind the one that answered the status
      expect(yield* statusOf({ head: 99, status: status(100) })).toStrictEqual(included)
      expect(yield* statusOf({ head: 100, status: status(100) })).toStrictEqual({
        _tag: "Confirmed",
        block: BigInt(100)
      })
    }))

  it.effect("reports a failure as Failed only once its slot is finalized and confirmed", () =>
    Effect.gen(function*() {
      const included = { _tag: "Included", block: BigInt(100) }
      expect(yield* statusOf({ head: 100, status: status(100, "confirmed", ERR) })).toStrictEqual(included)
      expect(yield* statusOf({ head: 99, status: status(100, "finalized", ERR) })).toStrictEqual(included)
      expect(yield* statusOf({ head: 100, status: status(100, "finalized", ERR) })).toStrictEqual({
        _tag: "Failed",
        block: BigInt(100),
        reason: ERR
      })
      expect(yield* statusOf({ head: 100, status: status(100, "finalized", "BlockhashNotFound") })).toStrictEqual({
        _tag: "Failed",
        block: BigInt(100),
        reason: "BlockhashNotFound"
      })
    }))

  it.effect("uses the confirmations option", () =>
    Effect.gen(function*() {
      expect((yield* statusOf({ head: 101, status: status(100) }, { confirmations: 2 }))._tag).toBe("Included")
      expect((yield* statusOf({ head: 102, status: status(100) }, { confirmations: 2 }))._tag).toBe("Confirmed")
    }))

  it.effect("reports an unknown transaction Expired once the finalized height is above lastValidBlockHeight", () =>
    Effect.gen(function*() {
      expect(yield* statusOf({ head: 100, height: 50 }, undefined, 50)).toStrictEqual({ _tag: "NotFound" })
      expect(yield* statusOf({ head: 100, height: 51 }, undefined, 50)).toStrictEqual({ _tag: "Expired" })
      // a transaction that landed is never Expired
      expect(yield* statusOf({ head: 100, height: 51, status: status(100, "processed") }, undefined, 50))
        .toStrictEqual({ _tag: "Included", block: BigInt(100) })
      expect((yield* statusOf({ head: 100, height: 51, status: status(100) }, undefined, 50))._tag).toBe("Confirmed")
    }))

  it.effect("reads the block height before the status, and only with lastValidBlockHeight", () =>
    Effect.gen(function*() {
      const without = setup({ head: 100, height: 51 })
      yield* without.run((relayer) => relayer.fetchTransactionStatus({ hash: HASH }))
      expect(without.node.calls).toStrictEqual(["getSignatureStatuses"])
      const given = setup({ head: 100, height: 51, status: status(100) })
      yield* given.run((relayer) => relayer.fetchTransactionStatus({ hash: HASH, lastValidBlockHeight: BigInt(50) }))
      expect(given.node.calls).toStrictEqual(["getBlockHeight", "getSignatureStatuses", "getSlot"])
    }))

  it.effect("awaitConfirmation polls every 10 seconds until the transaction is confirmed", () => {
    const { node, run } = setup({ head: 100 })
    return run((relayer) =>
      Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(relayer.awaitConfirmation({ hash: HASH }))
        yield* TestClock.adjust(0)
        expect(node.polls).toBe(1)
        node.current = { head: 100, status: status(101, "processed") }
        yield* TestClock.adjust("9 seconds")
        expect(node.polls).toBe(1)
        yield* TestClock.adjust("1 second")
        expect(node.polls).toBe(2)
        node.current = { head: 100, status: status(101, "confirmed") }
        yield* TestClock.adjust("10 seconds")
        expect(node.polls).toBe(3)
        expect(fiber.pollUnsafe()).toBeUndefined()
        node.current = { head: 101, status: status(101) }
        yield* TestClock.adjust("10 seconds")
        expect(yield* Fiber.join(fiber)).toStrictEqual({ _tag: "Confirmed", block: BigInt(101) })
        expect(node.polls).toBe(4)
      })
    )
  })

  it.effect("awaitConfirmation stops on Expired", () => {
    const { node, run } = setup({ head: 100, height: 50 })
    return run((relayer) =>
      Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(
          relayer.awaitConfirmation({ hash: HASH, lastValidBlockHeight: BigInt(50) })
        )
        yield* TestClock.adjust(0)
        expect(fiber.pollUnsafe()).toBeUndefined()
        node.current = { head: 101, height: 51 }
        yield* TestClock.adjust("10 seconds")
        expect(yield* Fiber.join(fiber)).toStrictEqual({ _tag: "Expired" })
        expect(node.polls).toBe(2)
      })
    )
  })

  it.effect("awaitConfirmation returns a finalized failure, and the last status when poll ends first", () =>
    Effect.gen(function*() {
      const failed = setup({ head: 100, status: status(100, "finalized", ERR) })
      expect((yield* failed.run((relayer) => relayer.awaitConfirmation({ hash: HASH })))._tag).toBe("Failed")
      expect(failed.node.polls).toBe(1)
      const unknown = setup({ head: 100 })
      expect(
        yield* unknown.run((relayer) => relayer.awaitConfirmation({ hash: HASH, poll: Schedule.recurs(2) }))
      ).toStrictEqual({ _tag: "NotFound" })
      expect(unknown.node.polls).toBe(3)
    }))
})
