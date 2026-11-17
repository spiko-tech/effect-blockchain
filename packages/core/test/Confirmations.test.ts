import * as Confirmations from "@effect-blockchain/core/Confirmations"
import * as JsonRpc from "@effect-blockchain/core/JsonRpc"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as TestClock from "effect/testing/TestClock"

class FakeRpcError extends Schema.TaggedError<FakeRpcError>()("FakeRpcError", { reason: JsonRpc.Reason }) {}

type Read = "Pending" | "Confirmed" | FakeRpcError

// a status fetch answering `reads` in order, then its last one
const setup = (...reads: ReadonlyArray<Read>) => {
  const state = { polls: 0 }
  const fetch = Effect.suspend(() => {
    const read = reads[Math.min(state.polls++, reads.length - 1)]
    return typeof read === "string" ? Effect.succeed(read) : Effect.fail(read)
  })
  const wait = (poll?: Schedule.Schedule<unknown>) =>
    Confirmations.awaitConfirmation({ fetch, isFinal: (status) => status === "Confirmed", poll })
  return { state, wait }
}

const unavailable = new FakeRpcError({ reason: new JsonRpc.Unavailable({ status: 429 }) })
const rejected = new FakeRpcError({ reason: new JsonRpc.Rejected() })

describe("Confirmations", () => {
  it("lastConfirmedBlock is the head minus the confirmations, never below 0", () => {
    expect(Confirmations.lastConfirmedBlock(BigInt(100), 5)).toBe(BigInt(95))
    expect(Confirmations.lastConfirmedBlock(BigInt(100), 0)).toBe(BigInt(100))
    expect(Confirmations.lastConfirmedBlock(BigInt(3), 5)).toBe(BigInt(0))
  })

  it.effect("awaitConfirmation polls every DEFAULT_POLL_INTERVAL until the status is final", () =>
    Effect.gen(function*() {
      const { state, wait } = setup("Pending", "Confirmed")
      const fiber = yield* Effect.forkChild(wait())
      yield* TestClock.adjust("9 seconds")
      expect(state.polls).toBe(1)
      yield* TestClock.adjust("1 second")
      expect(yield* Fiber.join(fiber)).toBe("Confirmed")
      expect(state.polls).toBe(2)
    }))

  it.effect("awaitConfirmation keeps waiting through a transient failure", () =>
    Effect.gen(function*() {
      const { state, wait } = setup("Pending", unavailable, "Pending", "Confirmed")
      const fiber = yield* Effect.forkChild(wait())
      yield* TestClock.adjust("20 seconds")
      expect(state.polls).toBe(3)
      expect(fiber.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust("10 seconds")
      expect(yield* Fiber.join(fiber)).toBe("Confirmed")
      expect(state.polls).toBe(4)
    }))

  it.effect("awaitConfirmation fails on a non-transient failure", () =>
    Effect.gen(function*() {
      const { state, wait } = setup("Pending", rejected, "Confirmed")
      const fiber = yield* Effect.forkChild(Effect.flip(wait()))
      yield* TestClock.adjust("10 seconds")
      expect(yield* Fiber.join(fiber)).toBe(rejected)
      expect(state.polls).toBe(2)
    }))

  it.effect("awaitConfirmation returns the last read when poll ends first", () =>
    Effect.gen(function*() {
      const pending = setup("Pending")
      expect(yield* pending.wait(Schedule.recurs(2))).toBe("Pending")
      expect(pending.state.polls).toBe(3)
      const failing = setup("Pending", unavailable)
      expect(yield* Effect.flip(failing.wait(Schedule.recurs(1)))).toBe(unavailable)
    }))
})
