import { SolanaAddress } from "@effect-blockchain/solana/SolanaAddress"
import * as SolanaRpc from "@effect-blockchain/solana/SolanaRpc"
import { SolanaTransactionHash } from "@effect-blockchain/solana/SolanaTransactionHash"
import { describe, expect, it } from "@effect/vitest"
import * as Arr from "effect/Array"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as fs from "node:fs"
import * as path from "node:path"
import { isDeepStrictEqual } from "node:util"

// real replies recorded by `scripts/record-fixtures.ts`, replayed through the real layer
const Fixture = Schema.fromJsonString(Schema.Struct({
  provider: Schema.String,
  network: Schema.String,
  recordedAt: Schema.String,
  request: Schema.Struct({ method: Schema.String, params: Schema.Json }),
  status: Schema.Number,
  body: Schema.String
}))

const load = (provider: string, name: string) =>
  Schema.decodeSync(Fixture)(
    fs.readFileSync(path.join(import.meta.dirname, "fixtures", provider, `${name}.json`), "utf8")
  )

interface FixtureEndpoint {
  readonly name: string
  readonly provider: string
  readonly cases: ReadonlyArray<string>
}

// one replay fetch for every endpoint, routed by host: `https://<name>.fixture`
const replay = (endpoints: Arr.NonEmptyReadonlyArray<FixtureEndpoint>) => {
  const fixtures = new Map(endpoints.map((e) => [e.name, e.cases.map((name) => load(e.provider, name))]))
  const calls: Array<string> = []
  const unmatched: Array<string> = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const name = new URL(String(input)).hostname.replace(/\.fixture$/, "")
    const request: { readonly method: string; readonly params: Schema.Json } = JSON.parse(
      await new Response(init?.body).text()
    )
    calls.push(`${name}:${request.method}`)
    const fixture = fixtures.get(name)?.find((f) =>
      f.request.method === request.method && isDeepStrictEqual(f.request.params, request.params)
    )
    if (fixture === undefined) {
      unmatched.push(`${name}: ${request.method} ${JSON.stringify(request.params)}`)
      return new Response("no fixture", { status: 404 })
    }
    return new Response(fixture.body, { status: fixture.status, headers: { "content-type": "application/json" } })
  }
  const layer = SolanaRpc.layer({
    network: "Solana",
    endpoints: Arr.map(endpoints, (e) => ({ name: e.name, url: Redacted.make(`https://${e.name}.fixture`) })),
    retries: 0
  }).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))
  )
  const run = <A, E>(f: (rpc: SolanaRpc.SolanaRpc["Service"]) => Effect.Effect<A, E>) =>
    Effect.gen(function*() {
      return yield* f(yield* SolanaRpc.SolanaRpc)
    }).pipe(
      Effect.provide(layer),
      Effect.exit,
      // an unmatched request fails the test on its own, whatever the call returned
      Effect.flatMap((exit) =>
        unmatched.length > 0 ? Effect.die(new Error(`no fixture for ${unmatched.join("; ")}`)) : exit
      )
    )
  return { calls, run }
}

const alchemy = (...cases: ReadonlyArray<string>) =>
  replay([{ name: "alchemy", provider: "alchemy", cases: ["getGenesisHash", ...cases] }])

const EUTBL = SolanaAddress.make("6rS8E5CQHLHmLenNNevUdJ9APzKNairr1kfWAM3EhDX3")
const BEFORE = SolanaTransactionHash.make(
  "4x5fSpdWHJPfbt7RWjFcqcNZ8iy31q5bfph7VgXY9oADn6q1a4zGUquoHFmJ9e6WXJ6ai5oLy54q5gyXs32mhZib"
)
const UNTIL = SolanaTransactionHash.make(
  "4HUA4Hbnr6hrEckfA9rzgfibnndv4v9tTvrKQWFtCKjcv8WZ1Co5HRHQCzZrsmfSUAw6uaXJSVYczKYT3F5D5sjR"
)
const TX_1 = SolanaTransactionHash.make(
  "2ijR446DGZ3zFMDdp5JrbonSpRwrvN4bGK7oGiLpn5DpR9eCFHZjMPh89feRiuygcVhhY6HxP64y5xtnVfKJutz1"
)
const TX_2 = SolanaTransactionHash.make(
  "2X2K6U3mUT7PFkcuh3N3u5T7ZaVdYKZh9eEHjfD4U92sYLqduHddwbCDDbZhyQbZZjMPdeKCzLEiNLR2LDWZzake"
)
const UNKNOWN_TX = SolanaTransactionHash.make(
  "5UfDuX7WXYZdgnWkLhKnga5PsaFdMNQdi5SBPYB4RY5UBbQDN3kQz3VEABDaGbNkYPhGMaFKaLwUMcnMnEHG77v"
)
const finalized = { commitment: "finalized" } as const
const page1 = { address: EUTBL, before: BEFORE, until: UNTIL, limit: 5, ...finalized }

describe("SolanaRpc fixtures", () => {
  it.effect("fixture: alchemy getGenesisHash", () =>
    alchemy().run((rpc) => rpc.getGenesisHash).pipe(
      Effect.map((hash) => expect(hash).toBe("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"))
    ))

  it.effect("fixture: alchemy getSlot", () =>
    alchemy("getSlot").run((rpc) => rpc.getSlot(finalized)).pipe(
      // the head moves on every recording: only check it is past the pinned transactions
      Effect.map((slot) => expect(slot > BigInt(443760316)).toBe(true))
    ))

  it.effect("fixture: alchemy getSignaturesForAddress-page-1 and -page-2", () =>
    alchemy("getSignaturesForAddress-page-1", "getSignaturesForAddress-page-2").run((rpc) =>
      Effect.gen(function*() {
        const first = yield* rpc.getSignaturesForAddress(page1)
        expect(first.map((s) => s.slot)).toStrictEqual(
          [443760316, 443117956, 442151719, 441936028, 441897517].map(BigInt)
        )
        expect(first[0]).toStrictEqual({
          signature: TX_1,
          slot: BigInt(443760316),
          blockTime: BigInt(1788372138),
          err: null,
          memo: null
        })
        const last = first[first.length - 1]
        const second = yield* rpc.getSignaturesForAddress({ ...page1, before: last?.signature })
        // the last page stops at `until`, short of `limit`
        expect(second.map((s) => s.slot)).toStrictEqual([441817387, 441419226, 435584879].map(BigInt))
      })
    ))

  it.effect("fixture: alchemy getTransaction-eutbl-1", () =>
    alchemy("getTransaction-eutbl-1").run((rpc) => rpc.getTransaction({ signature: TX_1, ...finalized })).pipe(
      Effect.map((tx) => {
        expect(tx.slot).toBe(BigInt(443760316))
        expect(tx.blockTime).toBe(BigInt(1788372138))
        expect(tx.transaction.startsWith("AVYBJWgkGJhjpWDnX/jt")).toBe(true)
        // u64 values come back as exact decimal strings
        expect(tx.meta).toMatchObject({
          err: null,
          fee: "45000",
          preBalances: expect.arrayContaining(["5740466850", "3388612899"]),
          postTokenBalances: [{ mint: EUTBL, uiTokenAmount: { amount: "0", decimals: "5" } }]
        })
      })
    ))

  it.effect("fixture: alchemy getTransaction-eutbl-2", () =>
    alchemy("getTransaction-eutbl-2").run((rpc) => rpc.getTransaction({ signature: TX_2, ...finalized })).pipe(
      Effect.map((tx) => {
        expect(tx.slot).toBe(BigInt(443117956))
        expect(tx.blockTime).toBe(BigInt(1788168720))
        expect(tx.meta).toMatchObject({ err: null, fee: "11173", preBalances: expect.arrayContaining(["2485421211"]) })
      })
    ))

  it.effect("fixture: alchemy getTransaction-unknown", () =>
    alchemy("getTransaction-unknown").run((rpc) =>
      Effect.flip(rpc.getTransaction({ signature: UNKNOWN_TX, ...finalized }))
    )
      .pipe(
        Effect.map((error) => {
          expect(error).toMatchObject({ reason: "Pruned", method: "getTransaction", endpoint: "alchemy" })
          expect(error.code).toBeUndefined()
        })
      ))

  // Alchemy ignores `minContextSlot` on getSignaturesForAddress: it answers instead of failing -32016 (`Lagging`)
  it.effect("fixture: alchemy getSignaturesForAddress-min-context-slot", () =>
    alchemy("getSignaturesForAddress-min-context-slot").run((rpc) =>
      rpc.getSignaturesForAddress({ ...page1, minContextSlot: BigInt(999_999_999_999) })
    ).pipe(Effect.map((page) => expect(page.map((s) => s.signature)[0]).toBe(TX_1))))

  it.effect("fixture: alchemy invalid-params", () =>
    alchemy("invalid-params").run((rpc) =>
      Effect.flip(rpc.getSignaturesForAddress({ address: EUTBL, limit: 0, ...finalized }))
    ).pipe(Effect.map((error) => expect(error).toMatchObject({ reason: "Rejected", code: -32602 }))))

  it.effect("fixture: alchemy invalid-key", () =>
    replay([{ name: "alchemy", provider: "alchemy", cases: ["invalid-key"] }]).run((rpc) =>
      Effect.flip(rpc.getSlot(finalized))
    ).pipe(Effect.map((error) =>
      // HTTP 401 with a JSON-RPC -32600 body: the status wins, and another endpoint may hold a valid key
      expect(error).toMatchObject({ reason: "Unavailable", code: 401, method: "getGenesisHash" })
    )))

  it.effect("fixture: alchemy fallback from invalid-key", () => {
    const { calls, run } = replay([
      { name: "alchemy-invalid-key", provider: "alchemy", cases: ["invalid-key"] },
      { name: "alchemy", provider: "alchemy", cases: ["getGenesisHash", "getTransaction-eutbl-1"] }
    ])
    return run((rpc) => rpc.getTransaction({ signature: TX_1, ...finalized })).pipe(Effect.map((tx) => {
      expect(tx.slot).toBe(BigInt(443760316))
      expect(calls).toStrictEqual([
        "alchemy-invalid-key:getGenesisHash",
        "alchemy:getGenesisHash",
        "alchemy:getTransaction"
      ])
    }))
  })
})
