import * as JsonRpc from "@effect-blockchain/core/JsonRpc"
import * as Replay from "@effect-blockchain/core/test/utils/replay"
import { StellarAccountAddress } from "@effect-blockchain/stellar/StellarAddress"
import * as StellarIndexer from "@effect-blockchain/stellar/StellarIndexer"
import * as StellarRpc from "@effect-blockchain/stellar/StellarRpc"
import { assert, describe, expect, it } from "@effect/vitest"
import { StrKey, xdr } from "@stellar/stellar-sdk"
import * as Arr from "effect/Array"
import * as BigInt_ from "effect/BigInt"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schedule from "effect/Schedule"
import * as Stream from "effect/Stream"
import * as TestClock from "effect/testing/TestClock"
import { account, accountKey, dataEntry, ledgerMeta, operation, update } from "./utils/ledgerMeta.ts"

const A = StellarAccountAddress.make(StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 1)))
const b = (n: number) => BigInt(n)

// A fake `StellarRpc` over the history of `A`: `changes` maps a ledger to the balance `A` ends it with, the first one
// creating it. `getLatestLedger` and `getLedgerEntries` answer at `state.head`, `getLedgers` builds the ledgers' metas,
// unless `metas` sets one. The n-th regular (`failAt`) or archive (`archiveFailAt`) `getLedgers` call (1-based) fails
// with the reason set for it. `entry` overrides the account entry at the head. A regular page starting below `oldest`
// fails `Pruned`; an `archive` page goes to `archivePages`, and fails `Rejected` as `StellarRpc` does when no endpoint
// is flagged `archive`.
const fakeRpc = (
  head: bigint,
  changes: ReadonlyMap<bigint, number>,
  options: {
    readonly failAt?: ReadonlyMap<number, JsonRpc.Reason>
    readonly archiveFailAt?: ReadonlyMap<number, JsonRpc.Reason>
    readonly metas?: ReadonlyMap<bigint, string>
    readonly entry?: StellarRpc.StellarLedgerEntry
    readonly oldest?: bigint
    readonly archive?: boolean
  } = {}
) => {
  const state = {
    head,
    pages: new Array<readonly [bigint, number | undefined]>(),
    archivePages: new Array<readonly [bigint, number | undefined]>(),
    accounts: 0
  }
  const fail = (reason: JsonRpc.Reason, method: string) =>
    Effect.fail(new StellarRpc.StellarRpcError({ reason, method, endpoint: "fake", cause: new Error(reason._tag) }))
  const lastChange = (ledger: bigint) =>
    Arr.last(Arr.sort(Arr.filter([...changes.keys()], (at) => at <= ledger), BigInt_.Order))
  const meta = (ledger: bigint) => {
    const set = options.metas?.get(ledger)
    if (set !== undefined) return set
    const to = changes.get(ledger)
    if (to === undefined) return ledgerMeta([])
    return ledgerMeta([
      operation(
        Option.match(lastChange(ledger - b(1)), {
          onNone: () => [xdr.LedgerEntryChange.ledgerEntryCreated(account(A, to))],
          onSome: (at) => update(A, changes.get(at) ?? 0, to, Number(at))
        })
      )
    ])
  }
  const layer = Layer.mock(StellarRpc.StellarRpc)({
    network: "Stellar",
    getLatestLedger: Effect.suspend(() => Effect.succeed({ sequence: state.head, id: "ab", protocolVersion: 23 })),
    getLedgers: (page) =>
      Effect.suspend(() => {
        if ("cursor" in page) return Effect.die("unused")
        const { limit, startLedger } = page
        if (page.archive === true) {
          if (options.archive !== true) {
            return Effect.fail(
              new StellarRpc.StellarRpcError({
                reason: new JsonRpc.Rejected(),
                method: "getLedgers",
                endpoint: "archive",
                cause: new Error("no endpoint is flagged archive")
              })
            )
          }
          state.archivePages.push([startLedger, limit])
          const reason = options.archiveFailAt?.get(state.archivePages.length)
          if (reason !== undefined) return fail(reason, "getLedgers")
        } else {
          state.pages.push([startLedger, limit])
          const reason = options.failAt?.get(state.pages.length)
          if (reason !== undefined) return fail(reason, "getLedgers")
          if (options.oldest !== undefined && startLedger < options.oldest) {
            return fail(new JsonRpc.Pruned(), "getLedgers")
          }
        }
        const end = BigInt_.min(startLedger + b(limit ?? 5) - b(1), state.head)
        return Effect.succeed({
          ledgers: Arr.makeBy(Number(end - startLedger) + 1, (i) => {
            const sequence = startLedger + b(i)
            return { sequence, closeTime: 1700000000 + i, metadataXdr: meta(sequence) }
          }),
          cursor: StellarRpc.StellarLedgersCursor.make({ endpoint: "fake", cursor: String(end) }),
          latestLedger: state.head,
          oldestLedger: b(1)
        })
      }),
    getLedgerEntries: ({ keys, minLedger }) =>
      Effect.suspend(() => {
        state.accounts++
        assert.deepStrictEqual(keys, [accountKey(A).toXdr("base64")])
        if (minLedger !== undefined && minLedger > state.head) {
          return fail(new JsonRpc.Lagging({ head: state.head, toBlock: minLedger }), "getLedgerEntries")
        }
        const entry = options.entry ?? Option.getOrUndefined(Option.map(lastChange(state.head), (at) => ({
          xdr: account(A, changes.get(at) ?? 0).data.toXdr("base64"),
          lastModifiedLedger: at
        })))
        return Effect.succeed({ entries: entry === undefined ? [] : [entry], latestLedger: state.head })
      })
  })
  return { layer, state }
}

const provide = <A, E>(
  effect: Effect.Effect<A, E, StellarIndexer.StellarIndexer>,
  rpc: Layer.Layer<StellarRpc.StellarRpc>
) => effect.pipe(Effect.provide(StellarIndexer.layer({ confirmations: 0 }).pipe(Layer.provide(rpc))))

const collect = (options: StellarIndexer.StellarIndexerNativeBalanceOptions) =>
  Effect.gen(function*() {
    const samples = new Array<readonly [bigint, bigint]>()
    const exit = yield* (yield* StellarIndexer.StellarIndexer).streamNativeBalance(options).pipe(
      Stream.runForEach((sample) => Effect.sync(() => samples.push([sample.block, sample.balance]))),
      Effect.exit
    )
    return { samples, exit }
  })

const fetchAt = (block: number, retry?: Schedule.Schedule<unknown, StellarRpc.StellarRpcError>) =>
  Effect.gen(function*() {
    return yield* (yield* StellarIndexer.StellarIndexer).fetchNativeBalance({ address: A, block: b(block), retry })
  })

// created at 105 with 50, then 70 at 112 and 60 at 118
const history = new Map([[b(105), 50], [b(112), 70], [b(118), 60]])

describe("StellarIndexer.fetchNativeBalance", () => {
  it.effect("fixture: Binance before and at its last change", () =>
    Effect.gen(function*() {
      const BINANCE = StellarAccountAddress.make("GABFQIK63R2NETJM7T673EAMZN4RJLLGP3OFUEJU5SZVTGWUKULZJNL6")
      const replay = Replay.replay(new URL("fixtures/", import.meta.url), [
        { name: "quasar", cases: ["getNetwork", "getLedgerEntries-binance", "getLedgers-binance"] }
      ])
      const layer = StellarIndexer.layer().pipe(
        Layer.provide(StellarRpc.layer({ network: "Stellar", endpoints: replay.endpoints, retries: 0 })),
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(Layer.succeed(FetchHttpClient.Fetch, replay.fetch))
      )
      const balances = yield* replay.check(
        Effect.gen(function*() {
          const indexer = yield* StellarIndexer.StellarIndexer
          return yield* Effect.forEach([65338910, 65338911], (block) =>
            indexer.fetchNativeBalance({ address: BINANCE, block: b(block) }))
        }).pipe(Effect.provide(layer))
      )
      // the ledger's "before" state, then the account entry at the head
      assert.deepStrictEqual(balances, [b(378110440126408), b(378110440136408)])
      assert.deepStrictEqual(replay.served, [
        "quasar getNetwork",
        "quasar getLedgerEntries-binance",
        "quasar getLedgers-binance",
        "quasar getLedgerEntries-binance"
      ])
    }))

  it.effect("hops back through the ledger of each change after the block, with one ledger per getLedgers call", () => {
    const { layer, state } = fakeRpc(b(200), history, { archive: true })
    return provide(fetchAt(106), layer).pipe(Effect.map((balance) => {
      assert.strictEqual(balance, b(50))
      // 118 names 112 as the previous change, and 112 names 105 <= 106
      assert.deepStrictEqual(state.pages, [[b(118), 1], [b(112), 1]])
      // ledgers the regular endpoints hold never reach the archive ones
      assert.deepStrictEqual(state.archivePages, [])
    }))
  })

  it.effect("reads 0 before the ledger that created the account", () => {
    const { layer, state } = fakeRpc(b(200), history)
    return provide(fetchAt(100), layer).pipe(Effect.map((balance) => {
      assert.strictEqual(balance, b(0))
      assert.deepStrictEqual(state.pages, [[b(118), 1], [b(112), 1], [b(105), 1]])
    }))
  })

  it.effect("reads the account entry at the head, without getLedgers, when it has not changed since the block", () => {
    const { layer, state } = fakeRpc(b(200), history)
    return provide(Effect.all([fetchAt(118), fetchAt(150)]), layer).pipe(Effect.map((balances) => {
      assert.deepStrictEqual(balances, [b(60), b(60)])
      assert.deepStrictEqual(state.pages, [])
    }))
  })

  it.effect("reads 0 for an account missing at the head, without getLedgers", () => {
    const { layer, state } = fakeRpc(b(200), new Map())
    return provide(fetchAt(100), layer).pipe(Effect.map((balance) => {
      assert.strictEqual(balance, b(0))
      assert.deepStrictEqual(state.pages, [])
    }))
  })

  it.effect("reads the balance before the first of several changes in a ledger", () => {
    // a fee charge of 1, then a payment of 9
    const metas = new Map([[b(118), ledgerMeta([operation(update(A, 69, 60, 118), update(A, 70, 69, 112))])]])
    const { layer, state } = fakeRpc(b(200), history, { metas })
    return provide(fetchAt(115), layer).pipe(Effect.map((balance) => {
      assert.strictEqual(balance, b(70))
      assert.deepStrictEqual(state.pages, [[b(118), 1]])
    }))
  })

  it.effect("fails InvalidResponse on a ledger without a change of the account, or naming a later previous change", () =>
    Effect.gen(function*() {
      const entry = { xdr: account(A, 5).data.toXdr("base64"), lastModifiedLedger: b(103) }
      const loop = new Map([[b(118), ledgerMeta([operation(update(A, 70, 60, 118))])]])
      for (const options of [{ entry }, { metas: loop }]) {
        const error = yield* Effect.flip(provide(fetchAt(100), fakeRpc(b(200), history, options).layer))
        assert.strictEqual(error.reason._tag, "InvalidResponse")
        assert.strictEqual(error.endpoint, "fake")
      }
    }))

  it.effect("dies on a malformed account entry, another entry type or another account's", () =>
    Effect.gen(function*() {
      const other = account(StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 2)), 5).data.toXdr("base64")
      for (const xdr of ["AAAA", dataEntry(A).data.toXdr("base64"), other]) {
        const exit = yield* Effect.exit(
          provide(fetchAt(100), fakeRpc(b(200), history, { entry: { xdr, lastModifiedLedger: b(103) } }).layer)
        )
        assert.isTrue(Exit.hasDies(exit))
      }
    }))

  it.effect("reads a ledger older than the regular endpoints' retention from the archive endpoints", () => {
    const { layer, state } = fakeRpc(b(200), history, { oldest: b(115), archive: true })
    return provide(fetchAt(106), layer).pipe(Effect.map((balance) => {
      assert.strictEqual(balance, b(50))
      assert.deepStrictEqual(state.pages, [[b(118), 1], [b(112), 1]])
      assert.deepStrictEqual(state.archivePages, [[b(112), 1]])
    }))
  })

  it.effect("fails Pruned on a pruned ledger when no endpoint is flagged archive", () => {
    const { layer, state } = fakeRpc(b(200), history, { oldest: b(150) })
    return provide(Effect.flip(fetchAt(106)), layer).pipe(Effect.map((error) => {
      assert.strictEqual(error.reason._tag, "Pruned")
      assert.strictEqual(error.endpoint, "fake")
      assert.deepStrictEqual(state.archivePages, [])
    }))
  })

  it.effect("retries a ledger read failing with a transient reason, with retry", () =>
    Effect.gen(function*() {
      const options = { oldest: b(150), archive: true, archiveFailAt: new Map([[1, new JsonRpc.Unavailable()]]) }
      const retried = fakeRpc(b(200), history, options)
      assert.strictEqual(yield* provide(fetchAt(106, Schedule.recurs(1)), retried.layer), b(50))
      assert.deepStrictEqual(retried.state.archivePages, [[b(118), 1], [b(118), 1], [b(112), 1]])
      const error = yield* Effect.flip(provide(fetchAt(106), fakeRpc(b(200), history, options).layer))
      assert.strictEqual(error.reason._tag, "Unavailable")
    }))

  it.effect("fails Lagging above the head", () =>
    provide(Effect.flip(fetchAt(201)), fakeRpc(b(200), history).layer).pipe(
      Effect.map((error) => expect(error.reason).toMatchObject({ _tag: "Lagging", head: b(200), toBlock: b(201) }))
    ))
})

describe("StellarIndexer.streamNativeBalance", () => {
  it.effect("samples every step, unchanged ones included, and ends at the last sample not above toBlock", () => {
    const { layer, state } = fakeRpc(b(200), history)
    return provide(collect({ address: A, fromBlock: b(100), toBlock: b(122), step: 5 }), layer).pipe(
      Effect.map(({ exit, samples }) => {
        assert.isTrue(Exit.isSuccess(exit))
        assert.deepStrictEqual(samples, [[b(100), b(0)], [b(105), b(50)], [b(110), b(50)], [b(115), b(70)], [
          b(120),
          b(60)
        ]])
        // back through each change for the first sample, then every ledger since the previous sample until the account
        // entry covers the sample (lastModifiedLedger 118 <= 120)
        assert.deepStrictEqual(state.pages, [[b(118), 1], [b(112), 1], [b(105), 1], [b(105), 1], [b(106), 5], [
          b(111),
          5
        ]])
        assert.strictEqual(state.accounts, 5)
      })
    )
  })

  it.effect("reads only the pages past the regular endpoints' retention from the archive endpoints", () => {
    const { layer, state } = fakeRpc(b(200), history, { oldest: b(108), archive: true })
    return provide(collect({ address: A, fromBlock: b(100), toBlock: b(120), step: 5 }), layer).pipe(
      Effect.map(({ exit, samples }) => {
        assert.isTrue(Exit.isSuccess(exit))
        assert.deepStrictEqual(samples, [[b(100), b(0)], [b(105), b(50)], [b(110), b(50)], [b(115), b(70)], [
          b(120),
          b(60)
        ]])
        // the pages starting below 108 are read on both, the later ones on the regular endpoints only
        assert.deepStrictEqual(state.pages, [[b(118), 1], [b(112), 1], [b(105), 1], [b(105), 1], [b(106), 5], [
          b(111),
          5
        ]])
        assert.deepStrictEqual(state.archivePages, [[b(105), 1], [b(105), 1], [b(106), 5]])
      })
    )
  })

  it.effect("makes no call for samples an account read already covers", () => {
    const { layer, state } = fakeRpc(b(200), new Map([[b(50), 10]]))
    return provide(collect({ address: A, fromBlock: b(100), toBlock: b(150), step: 10 }), layer).pipe(
      Effect.map(({ samples }) => {
        assert.deepStrictEqual(samples.map(([, balance]) => balance), Arr.makeBy(6, () => b(10)))
        assert.strictEqual(state.accounts, 1)
        assert.deepStrictEqual(state.pages, [])
      })
    )
  })

  it.effect("is empty without a call when fromBlock > toBlock", () => {
    const { layer, state } = fakeRpc(b(200), history)
    return provide(collect({ address: A, fromBlock: b(101), toBlock: b(100), step: 1 }), layer).pipe(
      Effect.map(({ samples }) => {
        assert.deepStrictEqual(samples, [])
        assert.strictEqual(state.accounts, 0)
      })
    )
  })

  it.effect("dies on a step that is not a positive safe integer", () =>
    Effect.gen(function*() {
      for (const step of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        const { exit } = yield* provide(
          collect({ address: A, fromBlock: b(100), step }),
          fakeRpc(b(200), history).layer
        )
        assert.isTrue(Exit.hasDies(exit), String(step))
        const defect = Result.getOrUndefined(Exit.findDefect(exit))
        assert.instanceOf(defect, RangeError)
      }
    }))

  it.effect("waits on poll for a sample above the confirmed head", () =>
    Effect.gen(function*() {
      const { layer, state } = fakeRpc(b(100), new Map([[b(50), 10]]))
      const samples = new Array<bigint>()
      const run = Effect.gen(function*() {
        yield* (yield* StellarIndexer.StellarIndexer).streamNativeBalance({ address: A, fromBlock: b(100), step: 5 })
          .pipe(Stream.runForEach((sample) => Effect.sync(() => samples.push(sample.block))))
      })
      yield* provide(run, layer).pipe(Effect.forkChild)
      yield* TestClock.adjust(0)
      assert.deepStrictEqual(samples, [b(100)])
      state.head = b(105)
      yield* TestClock.adjust(StellarIndexer.DEFAULT_POLL_INTERVAL)
      assert.deepStrictEqual(samples, [b(100), b(105)])
      // one account read per sample once caught up
      assert.strictEqual(state.accounts, 2)
    }))

  it.effect("retries a sample failing with a transient reason, with retry", () => {
    const { layer, state } = fakeRpc(b(200), history, { failAt: new Map([[1, new JsonRpc.Unavailable()]]) })
    const options = { address: A, fromBlock: b(100), toBlock: b(105), step: 5, retry: Schedule.recurs(1) }
    return provide(collect(options), layer).pipe(Effect.map(({ samples }) => {
      assert.deepStrictEqual(samples, [[b(100), b(0)], [b(105), b(50)]])
      assert.strictEqual(state.pages[0][0], state.pages[1][0])
    }))
  })

  it.effect("fails on the first failure without retry", () => {
    const { layer, state } = fakeRpc(b(200), history, {
      failAt: new Map([[1, new JsonRpc.Unavailable()]]),
      archive: true
    })
    return provide(collect({ address: A, fromBlock: b(100), step: 5 }), layer).pipe(Effect.map(({ exit, samples }) => {
      assert.deepStrictEqual(samples, [])
      // only `Pruned` sends a page to the archive endpoints
      assert.deepStrictEqual(state.archivePages, [])
      assert.strictEqual(Option.getOrUndefined(Exit.findErrorOption(exit))?.reason._tag, "Unavailable")
    }))
  })
})
