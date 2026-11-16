import * as Replay from "@effect-blockchain/core/test/utils/replay"
import * as StellarRelayer from "@effect-blockchain/stellar/StellarRelayer"
import * as StellarRpc from "@effect-blockchain/stellar/StellarRpc"
import { StellarTransactionHash } from "@effect-blockchain/stellar/StellarTransactionHash"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import * as Schedule from "effect/Schedule"
import * as TestClock from "effect/testing/TestClock"

const HASH = StellarTransactionHash.make("0x" + "cd".repeat(32))

// a `TransactionResult` without operation results: a fee of 100 stroops, the result code and an empty extension
const resultXdr = (code: number) => {
  const bytes = Buffer.alloc(16)
  bytes.writeBigInt64BE(BigInt(100), 0)
  bytes.writeInt32BE(code, 8)
  return bytes.toString("base64")
}
const TX_BAD_SEQ = -5

interface Transaction {
  readonly ledger: number
  readonly status?: "SUCCESS" | "FAILED"
  readonly resultXdr?: string
}

interface Node {
  readonly head: number
  readonly oldest?: number
  readonly transaction?: Transaction
}

// a fake service answering from `node.current`, which a test replaces between polls
const setup = (initial: Node, options?: Parameters<typeof StellarRelayer.layer>[0]) => {
  const node = { current: initial, polls: 0 }
  const rpc = Layer.succeed(
    StellarRpc.StellarRpc,
    StellarRpc.StellarRpc.of({
      network: "Stellar",
      getNetwork: Effect.die("unused"),
      getLatestLedger: Effect.die("unused"),
      getEvents: () => Effect.die("unused"),
      getLedgers: () => Effect.die("unused"),
      getLedgerEntries: () => Effect.die("unused"),
      getTransaction: () =>
        Effect.sync((): StellarRpc.StellarTransactionInfo => {
          node.polls++
          const { head, oldest = 1, transaction } = node.current
          const range = { latestLedger: BigInt(head), oldestLedger: BigInt(oldest) }
          return transaction === undefined ? { status: "NOT_FOUND", ...range } : {
            status: transaction.status ?? "SUCCESS",
            ...range,
            ledger: BigInt(transaction.ledger),
            createdAt: 1794833332,
            applicationOrder: 1,
            feeBump: false,
            envelopeXdr: "",
            resultXdr: transaction.resultXdr ?? resultXdr(0),
            resultMetaXdr: ""
          }
        })
    })
  )
  const run = <A, E>(f: (relayer: StellarRelayer.StellarRelayer["Service"]) => Effect.Effect<A, E>) =>
    Effect.gen(function*() {
      return yield* f(yield* StellarRelayer.StellarRelayer)
    }).pipe(Effect.provide(StellarRelayer.layer(options).pipe(Layer.provide(rpc))))
  return { node, run }
}

const statusOf = (node: Node, maxLedger?: number, options?: Parameters<typeof StellarRelayer.layer>[0]) =>
  setup(node, options).run((relayer) =>
    relayer.fetchTransactionStatus({ hash: HASH, maxLedger: maxLedger === undefined ? undefined : BigInt(maxLedger) })
  )

describe("StellarRelayer", () => {
  it.effect("maps what the node knows to a status", () =>
    Effect.gen(function*() {
      expect(yield* statusOf({ head: 100 })).toStrictEqual({ _tag: "NotFound" })
      // Stellar confirms a ledger once closed
      expect(yield* statusOf({ head: 100, transaction: { ledger: 100 } })).toStrictEqual({
        _tag: "Confirmed",
        block: BigInt(100)
      })
    }))

  it.effect("reports an unknown transaction as Expired once the latest ledger is above maxLedger", () =>
    Effect.gen(function*() {
      expect(yield* statusOf({ head: 100 }, 100)).toStrictEqual({ _tag: "NotFound" })
      expect(yield* statusOf({ head: 101 }, 100)).toStrictEqual({ _tag: "Expired" })
      expect(yield* statusOf({ head: 101, oldest: 100 }, 100)).toStrictEqual({ _tag: "Expired" })
      // the node retains no ledger the transaction could be in
      expect(yield* statusOf({ head: 200, oldest: 101 }, 100)).toStrictEqual({ _tag: "NotFound" })
      expect((yield* statusOf({ head: 101, transaction: { ledger: 100 } }, 100))._tag).toBe("Confirmed")
    }))

  it.effect("reports a failure with its result code", () =>
    Effect.gen(function*() {
      const failed = (resultXdr: string) =>
        statusOf({ head: 100, transaction: { ledger: 100, status: "FAILED", resultXdr } })
      expect(yield* failed(resultXdr(TX_BAD_SEQ))).toStrictEqual({
        _tag: "Failed",
        block: BigInt(100),
        reason: { code: "txBadSeq", operations: [] }
      })
      // a result code the SDK does not know, and a result that is not XDR
      for (const unknown of [resultXdr(-99), "not XDR"]) {
        expect(yield* failed(unknown)).toStrictEqual({ _tag: "Failed", block: BigInt(100), reason: undefined })
      }
    }))

  it.effect("uses the confirmations option, for a failure too", () =>
    Effect.gen(function*() {
      const options = { confirmations: 2 }
      const failure = { ledger: 100, status: "FAILED", resultXdr: resultXdr(TX_BAD_SEQ) } as const
      expect(yield* statusOf({ head: 101, transaction: { ledger: 100 } }, undefined, options)).toStrictEqual({
        _tag: "Included",
        block: BigInt(100)
      })
      expect((yield* statusOf({ head: 102, transaction: { ledger: 100 } }, undefined, options))._tag).toBe("Confirmed")
      expect(yield* statusOf({ head: 101, transaction: failure }, undefined, options)).toStrictEqual({
        _tag: "Included",
        block: BigInt(100)
      })
      expect((yield* statusOf({ head: 102, transaction: failure }, undefined, options))._tag).toBe("Failed")
    }))

  it.effect("awaitConfirmation polls every 10 seconds until the transaction is confirmed", () => {
    const { node, run } = setup({ head: 100 }, { confirmations: 1 })
    return run((relayer) =>
      Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(relayer.awaitConfirmation({ hash: HASH, maxLedger: BigInt(110) }))
        yield* TestClock.adjust(0)
        expect(node.polls).toBe(1)
        yield* TestClock.adjust("9 seconds")
        expect(node.polls).toBe(1)
        node.current = { head: 102, transaction: { ledger: 102 } }
        yield* TestClock.adjust("1 second")
        expect(node.polls).toBe(2)
        expect(fiber.pollUnsafe()).toBeUndefined()
        node.current = { head: 103, transaction: { ledger: 102 } }
        yield* TestClock.adjust("10 seconds")
        expect(yield* Fiber.join(fiber)).toStrictEqual({ _tag: "Confirmed", block: BigInt(102) })
        expect(node.polls).toBe(3)
      })
    )
  })

  it.effect("awaitConfirmation stops on Expired", () => {
    const { node, run } = setup({ head: 100 })
    return run((relayer) =>
      Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(relayer.awaitConfirmation({ hash: HASH, maxLedger: BigInt(100) }))
        yield* TestClock.adjust(0)
        expect(fiber.pollUnsafe()).toBeUndefined()
        node.current = { head: 101 }
        yield* TestClock.adjust("10 seconds")
        expect(yield* Fiber.join(fiber)).toStrictEqual({ _tag: "Expired" })
        expect(node.polls).toBe(2)
      })
    )
  })

  it.effect("awaitConfirmation returns a failure, and the last status when poll ends first", () =>
    Effect.gen(function*() {
      const failed = setup({ head: 100, transaction: { ledger: 100, status: "FAILED" } })
      expect((yield* failed.run((relayer) => relayer.awaitConfirmation({ hash: HASH })))._tag).toBe("Failed")
      expect(failed.node.polls).toBe(1)
      const unknown = setup({ head: 100 })
      expect(
        yield* unknown.run((relayer) => relayer.awaitConfirmation({ hash: HASH, poll: Schedule.recurs(2) }))
      ).toStrictEqual({ _tag: "NotFound" })
      expect(unknown.node.polls).toBe(3)
    }))

  // the pinned transactions of `scripts/record-fixtures.ts`, recorded at latest ledger 65509517
  it.effect("fixture: quasar status of a confirmed, a failed and an unknown transaction", () => {
    const { check, endpoints, fetch, served } = Replay.replay(new URL("fixtures/", import.meta.url), [{
      name: "quasar",
      cases: [
        "getNetwork",
        "getTransaction-success",
        "getTransaction-failed",
        "getTransaction-failed-fee-bump",
        "getTransaction-not-found"
      ]
    }])
    const layer = StellarRelayer.layer().pipe(
      Layer.provide(StellarRpc.layer({ network: "Stellar", endpoints, retries: 0 })),
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))
    )
    const hash = (hex: string) => StellarTransactionHash.make(`0x${hex}`)
    return check(
      Effect.gen(function*() {
        const relayer = yield* StellarRelayer.StellarRelayer
        expect(
          yield* relayer.fetchTransactionStatus({
            hash: hash("8ed811d0439b12fd5f4a2ebd043138079c46a82c9d51544fecb5379bbaf48505")
          })
        ).toStrictEqual({ _tag: "Confirmed", block: BigInt(65509458) })
        expect(
          yield* relayer.fetchTransactionStatus({
            hash: hash("b1301e5ba2c2b35c9485cd8369f4c258d65666cf270cc3f2f9c03b72dded2059")
          })
        ).toStrictEqual({
          _tag: "Failed",
          block: BigInt(65509460),
          reason: {
            code: "txFailed",
            operations: [
              "opTooManySubentries",
              "manageBuyOfferUnderfunded",
              "opTooManySubentries",
              "manageSellOfferSuccess"
            ]
          }
        })
        expect(
          yield* relayer.fetchTransactionStatus({
            hash: hash("f575e03ba3b857e660410be887643c78932a5cbb3be80050ef0bd0949d0fdbaf")
          })
        ).toStrictEqual({
          _tag: "Failed",
          block: BigInt(65509458),
          reason: { code: "txFailed", operations: ["manageBuyOfferSellNoTrust"] }
        })
        const unknown = hash("ab".repeat(32))
        expect(yield* relayer.fetchTransactionStatus({ hash: unknown })).toStrictEqual({ _tag: "NotFound" })
        expect(yield* relayer.fetchTransactionStatus({ hash: unknown, maxLedger: BigInt(65509517) })).toStrictEqual({
          _tag: "NotFound"
        })
        expect(yield* relayer.fetchTransactionStatus({ hash: unknown, maxLedger: BigInt(65509516) })).toStrictEqual({
          _tag: "Expired"
        })
        expect(served).toStrictEqual([
          "quasar getNetwork",
          "quasar getTransaction-success",
          "quasar getTransaction-failed",
          "quasar getTransaction-failed-fee-bump",
          "quasar getTransaction-not-found",
          "quasar getTransaction-not-found",
          "quasar getTransaction-not-found"
        ])
      }).pipe(Effect.provide(layer))
    )
  })
})
