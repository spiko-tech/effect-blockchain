import * as JsonRpc from "@effect-blockchain/core/JsonRpc"
import { SolanaAddress } from "@effect-blockchain/solana/SolanaAddress"
import * as SolanaIndexer from "@effect-blockchain/solana/SolanaIndexer"
import * as SolanaRpc from "@effect-blockchain/solana/SolanaRpc"
import { SolanaTransactionHash } from "@effect-blockchain/solana/SolanaTransactionHash"
import { describe, expect, it } from "@effect/vitest"
import { getBase58Decoder } from "@solana/kit"
import * as Arr from "effect/Array"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as Schedule from "effect/Schedule"
import * as Stream from "effect/Stream"
import * as TestClock from "effect/testing/TestClock"

const ADDRESS = SolanaAddress.make("5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9")
const OTHER = SolanaAddress.make("6rS8E5CQHLHmLenNNevUdJ9APzKNairr1kfWAM3EhDX3")

const signature = (n: number) =>
  SolanaTransactionHash.make(getBase58Decoder().decode(new Uint8Array(64).map((_, i) => i === 0 ? n : 7)))

interface Tx {
  readonly slot: number
  readonly post: number
  // `ADDRESS` is a loaded writable address by default, a static key of a legacy transaction, absent, or without meta
  readonly shape?: "legacy" | "missing" | "noMeta"
}

/**
 * A fake `SolanaRpc`: `txs` in chain order, each moving the balance of `ADDRESS` from the previous `post` (0 for the
 * first) to its own, `getBalance` answering `balance` at `balanceSlot`, the finalized `head` by default. Every call is logged in `state.calls`,
 * a transaction by its index in `txs`, and the call numbered `n` (from 1) fails with `failAt.get(n)`.
 */
const fakeRpc = (options: {
  readonly head: number
  readonly txs: ReadonlyArray<Tx>
  readonly balance?: number
  readonly balanceSlot?: number
  readonly failAt?: ReadonlyMap<number, JsonRpc.Reason>
}) => {
  const state = { head: BigInt(options.head), calls: new Array<string>() }
  const call = <A>(method: string, value: () => A) =>
    Effect.suspend(() => {
      state.calls.push(method)
      const reason = options.failAt?.get(state.calls.length)
      return reason === undefined
        ? Effect.sync(value)
        : Effect.fail(new SolanaRpc.SolanaRpcError({ reason, method, endpoint: "fake", cause: new Error(reason._tag) }))
    })
  const infos = options.txs.map((tx, i): SolanaRpc.SolanaSignatureInfo => ({
    signature: signature(i),
    slot: BigInt(tx.slot),
    blockTime: null,
    err: null,
    memo: null
  }))
  // a page holds 1000 signatures: the history is newest first
  const history = Arr.reverse(infos)
  function getTransaction(
    options: SolanaRpc.SolanaTransactionQuery & { readonly encoding?: "base64" | undefined }
  ): Effect.Effect<SolanaRpc.SolanaTransactionInfo, SolanaRpc.SolanaRpcError>
  function getTransaction<Encoding extends SolanaRpc.SolanaTransactionEncoding>(
    options: SolanaRpc.SolanaTransactionQuery & { readonly encoding: Encoding }
  ): Effect.Effect<SolanaRpc.SolanaTransactionInfo<Encoding>, SolanaRpc.SolanaRpcError>
  function getTransaction(
    query: SolanaRpc.SolanaTransactionQuery & { readonly encoding?: SolanaRpc.SolanaTransactionEncoding | undefined }
  ): Effect.Effect<
    SolanaRpc.SolanaTransactionInfo<SolanaRpc.SolanaTransactionEncoding>,
    SolanaRpc.SolanaRpcError
  > {
    const index = infos.findIndex((e) => e.signature === query.signature)
    const tx = options.txs[index]
    const pre = BigInt(options.txs[index - 1]?.post ?? 0)
    return call(`getTransaction ${index} ${query.encoding}`, () => ({
      slot: BigInt(tx?.slot ?? 0),
      blockTime: null,
      transaction: {
        signatures: [query.signature],
        message: {
          accountKeys: tx?.shape === "legacy" ? [OTHER, ADDRESS] : [OTHER],
          header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 0 },
          recentBlockhash: "",
          instructions: []
        }
      },
      meta: tx?.shape === "noMeta" ? null : {
        err: null,
        fee: BigInt(5000),
        preBalances: [BigInt(1), pre],
        postBalances: [BigInt(1), BigInt(tx?.post ?? 0)],
        ...tx?.shape === "legacy" ? {} : {
          loadedAddresses: { writable: tx?.shape === "missing" ? [] : [ADDRESS], readonly: [] }
        }
      }
    }))
  }
  const layer = Layer.succeed(
    SolanaRpc.SolanaRpc,
    SolanaRpc.SolanaRpc.of({
      network: "Solana",
      getGenesisHash: Effect.die("unused"),
      getSlot: () => call("getSlot", () => state.head),
      getBalance: ({ address }) =>
        call("getBalance", () => {
          expect(address).toBe(ADDRESS)
          return { slot: BigInt(options.balanceSlot ?? state.head), value: BigInt(options.balance ?? 0) }
        }),
      getSignaturesForAddress: ({ address, before, limit }) =>
        call("getSignaturesForAddress", () => {
          expect(address).toBe(ADDRESS)
          const start = history.findIndex((e) => e.signature === before) + 1
          return history.slice(start, start + (limit ?? 1000))
        }),
      getTransaction
    })
  )
  return { layer, state }
}

const provide = <A, E>(
  effect: Effect.Effect<A, E, SolanaIndexer.SolanaIndexer>,
  rpc: Layer.Layer<SolanaRpc.SolanaRpc>,
  confirmations = 0
) => effect.pipe(Effect.provide(SolanaIndexer.layer({ confirmations }).pipe(Layer.provide(rpc))))

const fetch = (block: number) =>
  Effect.gen(function*() {
    return yield* (yield* SolanaIndexer.SolanaIndexer).fetchNativeBalance({ address: ADDRESS, block: BigInt(block) })
  })

const getTransactions = (state: { readonly calls: ReadonlyArray<string> }) =>
  state.calls.filter((c) => c.startsWith("getTransaction"))

// balances 100 after slot 10, 250 after slot 20 (two in slot 20), 50 after slot 30
const txs: ReadonlyArray<Tx> = [{ slot: 10, post: 100 }, { slot: 20, post: 200 }, { slot: 20, post: 250 }, {
  slot: 30,
  post: 50
}]

describe("SolanaIndexer.fetchNativeBalance", () => {
  it.effect("reads the postBalances of the newest transaction at or before the block, in json", () => {
    const { layer, state } = fakeRpc({ head: 100, txs })
    return provide(Effect.all([fetch(10), fetch(25), fetch(20)]), layer).pipe(Effect.map((balances) => {
      expect(balances).toStrictEqual([100, 250, 250].map(BigInt))
      expect(state.calls).toStrictEqual([
        "getSlot",
        "getSignaturesForAddress",
        "getTransaction 0 json",
        "getSlot",
        "getSignaturesForAddress",
        "getTransaction 2 json",
        "getSlot",
        "getSignaturesForAddress",
        "getTransaction 2 json"
      ])
    }))
  })

  it.effect("reads the preBalances of the first transaction after a block before any", () => {
    const { layer, state } = fakeRpc({ head: 100, txs: [{ slot: 10, post: 100 }, { slot: 20, post: 300 }] })
    return provide(Effect.all([fetch(15), fetch(5)]), layer).pipe(Effect.map((balances) => {
      expect(balances).toStrictEqual([100, 0].map(BigInt))
      expect(getTransactions(state)).toStrictEqual(["getTransaction 0 json", "getTransaction 0 json"])
    }))
  })

  it.effect("reads 0 below the confirmed head for an address without transactions", () => {
    const { layer, state } = fakeRpc({ head: 100, txs: [], balance: 7 })
    return provide(fetch(99), layer).pipe(Effect.map((balance) => {
      expect(balance).toBe(BigInt(0))
      expect(state.calls).toStrictEqual(["getSlot", "getSignaturesForAddress"])
    }))
  })

  it.effect("reads getBalance at or above the confirmed head when no transaction is newer", () =>
    Effect.gen(function*() {
      for (const [history, block] of [[txs, 100], [txs, 1000], [[], 100]] as const) {
        const { layer, state } = fakeRpc({ head: 100, txs: history, balance: 7 })
        expect(yield* provide(fetch(block), layer)).toBe(BigInt(7))
        expect(state.calls).toStrictEqual(["getSlot", "getBalance", "getSignaturesForAddress"])
      }
    }))

  it.effect("reads the transaction at the confirmed head when one is newer than the block", () => {
    // confirmed head 28: the transaction at slot 30 is finalized but above it
    const { layer, state } = fakeRpc({ head: 30, txs, balance: 7 })
    return provide(fetch(28), layer, 2).pipe(Effect.map((balance) => {
      expect(balance).toBe(BigInt(250))
      expect(state.calls).toStrictEqual(["getSlot", "getBalance", "getSignaturesForAddress", "getTransaction 2 json"])
    }))
  })

  it.effect("reads the transaction when getBalance answers below a newer transaction under the block", () => {
    // a transaction lands at slot 30 after getBalance answered at slot 25
    const { layer, state } = fakeRpc({ head: 30, txs, balance: 7, balanceSlot: 25 })
    return provide(fetch(40), layer).pipe(Effect.map((balance) => {
      expect(balance).toBe(BigInt(50))
      expect(state.calls).toStrictEqual(["getSlot", "getBalance", "getSignaturesForAddress", "getTransaction 3 json"])
    }))
  })

  it.effect("reads a static key of a legacy transaction without loaded addresses", () => {
    const { layer } = fakeRpc({ head: 100, txs: [{ slot: 10, post: 100, shape: "legacy" }] })
    return provide(fetch(50), layer).pipe(Effect.map((balance) => expect(balance).toBe(BigInt(100))))
  })

  for (const shape of ["missing", "noMeta"] as const) {
    it.effect(`fails InvalidResponse when the transaction ${shape === "missing" ? "omits the address" : "has no meta"}`, () => {
      const { layer } = fakeRpc({ head: 100, txs: [{ slot: 10, post: 100, shape }] })
      return provide(Effect.flip(fetch(50)), layer).pipe(Effect.map((error) => {
        expect(error).toMatchObject({ reason: { _tag: "InvalidResponse" }, method: "getTransaction" })
      }))
    })
  }
})

const stream = (options: Omit<SolanaIndexer.SolanaIndexerNativeBalanceOptions, "address">) =>
  Effect.gen(function*() {
    const samples = new Array<readonly [number, number]>()
    const exit = yield* (yield* SolanaIndexer.SolanaIndexer).streamNativeBalance({ address: ADDRESS, ...options }).pipe(
      Stream.runForEach(({ balance, block }) => Effect.sync(() => samples.push([Number(block), Number(balance)]))),
      Effect.exit
    )
    return { samples, exit }
  })

describe("SolanaIndexer.streamNativeBalance", () => {
  it.effect("samples every step up to the last one not above toBlock, reading only the newest meta of a window", () => {
    const { layer, state } = fakeRpc({ head: 100, txs })
    return provide(stream({ fromBlock: BigInt(5), toBlock: BigInt(44), step: 10 }), layer).pipe(
      Effect.map(({ exit, samples }) => {
        expect(Exit.isSuccess(exit)).toBe(true)
        expect(samples).toStrictEqual([[5, 0], [15, 100], [25, 250], [35, 50]])
        // slot 5 from the first transaction's preBalances, then one meta per window with a transaction
        expect(getTransactions(state)).toStrictEqual([
          "getTransaction 0 json",
          "getTransaction 0 json",
          "getTransaction 2 json",
          "getTransaction 3 json"
        ])
      })
    )
  })

  it.effect("repeats the previous balance through windows without transactions", () => {
    const { layer, state } = fakeRpc({ head: 100, txs: [{ slot: 10, post: 100 }, { slot: 60, post: 300 }] })
    return provide(stream({ fromBlock: BigInt(0), toBlock: BigInt(30), step: 10 }), layer).pipe(
      Effect.map(({ samples }) => {
        expect(samples).toStrictEqual([[0, 0], [10, 100], [20, 100], [30, 100]])
        expect(getTransactions(state)).toStrictEqual(["getTransaction 0 json", "getTransaction 0 json"])
      })
    )
  })

  it.effect("repeats the previous balance before the first transaction", () => {
    const { layer, state } = fakeRpc({ head: 100, txs: [{ slot: 60, post: 300 }] })
    return provide(stream({ fromBlock: BigInt(0), toBlock: BigInt(10), step: 10 }), layer).pipe(
      Effect.map(({ samples }) => {
        expect(samples).toStrictEqual([[0, 0], [10, 0]])
        expect(getTransactions(state)).toStrictEqual(["getTransaction 0 json"])
      })
    )
  })

  it.effect("starts from getBalance at the confirmed head", () => {
    const { layer, state } = fakeRpc({ head: 50, txs, balance: 7 })
    return provide(stream({ fromBlock: BigInt(50), step: 10, poll: Schedule.recurs(0) }), layer).pipe(
      Effect.map(({ exit, samples }) => {
        expect(Exit.isSuccess(exit)).toBe(true)
        expect(samples).toStrictEqual([[50, 7]])
        expect(state.calls).toStrictEqual(["getSlot", "getBalance", "getSignaturesForAddress", "getSlot"])
      })
    )
  })

  it.effect("waits on poll for a sample above the confirmed head", () =>
    Effect.gen(function*() {
      const { layer, state } = fakeRpc({ head: 15, txs })
      const fiber = yield* provide(stream({ fromBlock: BigInt(5), toBlock: BigInt(25), step: 10 }), layer).pipe(
        Effect.forkChild
      )
      yield* TestClock.adjust(0)
      expect(state.calls.filter((c) => c === "getSlot")).toHaveLength(3)
      state.head = BigInt(25)
      yield* TestClock.adjust(SolanaIndexer.DEFAULT_POLL_INTERVAL)
      const { samples } = yield* Fiber.join(fiber)
      expect(samples).toStrictEqual([[5, 0], [15, 100], [25, 250]])
    }))

  it.effect("ends when poll ends before the next sample is confirmed", () => {
    const { layer } = fakeRpc({ head: 20, txs })
    return provide(stream({ fromBlock: BigInt(0), step: 15, poll: Schedule.recurs(0) }), layer).pipe(
      Effect.map(({ exit, samples }) => {
        expect(Exit.isSuccess(exit)).toBe(true)
        expect(samples).toStrictEqual([[0, 0], [15, 100]])
      })
    )
  })

  it.effect("retries a sample failing with a transient reason at the same block, with retry", () => {
    // call 6 is the second sample's transaction
    const { layer, state } = fakeRpc({ head: 100, txs, failAt: new Map([[6, new JsonRpc.Unavailable()]]) })
    const options = { fromBlock: BigInt(10), toBlock: BigInt(20), step: 10, retry: Schedule.recurs(1) }
    return provide(stream(options), layer).pipe(Effect.map(({ exit, samples }) => {
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(samples).toStrictEqual([[10, 100], [20, 250]])
      expect(state.calls.slice(3)).toStrictEqual([
        "getSlot",
        "getSignaturesForAddress",
        "getTransaction 2 json",
        "getSlot",
        "getSignaturesForAddress",
        "getTransaction 2 json"
      ])
    }))
  })

  it.effect("fails on a transient failure without retry", () => {
    const { layer } = fakeRpc({ head: 100, txs, failAt: new Map([[6, new JsonRpc.Unavailable()]]) })
    return provide(stream({ fromBlock: BigInt(10), toBlock: BigInt(20), step: 10 }), layer).pipe(
      Effect.map(({ exit, samples }) => {
        expect(samples).toStrictEqual([[10, 100]])
        expect(Exit.isFailure(exit)).toBe(true)
      })
    )
  })

  it.effect("is empty without a call when fromBlock > toBlock", () => {
    const { layer, state } = fakeRpc({ head: 100, txs })
    return provide(stream({ fromBlock: BigInt(11), toBlock: BigInt(10), step: 1 }), layer).pipe(
      Effect.map(({ samples }) => {
        expect(samples).toStrictEqual([])
        expect(state.calls).toStrictEqual([])
      })
    )
  })

  it.effect("dies on a step that is not a positive safe integer", () =>
    Effect.gen(function*() {
      for (const step of [0, -1, 1.5, 2 ** 53]) {
        const { layer } = fakeRpc({ head: 100, txs })
        const { exit } = yield* provide(stream({ fromBlock: BigInt(0), step }), layer)
        expect(Result.getOrUndefined(Exit.findDefect(exit))).toBeInstanceOf(RangeError)
      }
    }))
})
