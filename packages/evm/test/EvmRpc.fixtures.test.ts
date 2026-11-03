// Real Ethereum mainnet replies, recorded by `scripts/record-fixtures.ts`, replayed through the real `EvmRpc.layer`
import { EvmAddress } from "@effect-blockchain/evm/EvmAddress"
import { EvmHexData } from "@effect-blockchain/evm/EvmHexData"
import * as EvmNetwork from "@effect-blockchain/evm/EvmNetwork"
import * as EvmRpc from "@effect-blockchain/evm/EvmRpc"
import { describe, expect, it } from "@effect/vitest"
import * as Arr from "effect/Array"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { readFileSync } from "node:fs"
import { isDeepStrictEqual } from "node:util"

const Fixture = Schema.fromJsonString(Schema.Struct({
  provider: Schema.String,
  network: Schema.String,
  recordedAt: Schema.String,
  request: Schema.Struct({ method: Schema.String, params: Schema.Json }),
  status: Schema.Number,
  body: Schema.String
}))
const Request = Schema.fromJsonString(Schema.Struct({ method: Schema.String, params: Schema.Json }))

const load = (provider: string, name: string) => ({
  name,
  ...Schema.decodeUnknownSync(Fixture)(
    readFileSync(new URL(`fixtures/${provider}/${name}.json`, import.meta.url), "utf8")
  )
})

// one replay fetch for every endpoint, routed by host (`https://<provider>.fixture`): each endpoint answers from its own
// fixtures, matched on method and params. An unmatched request fails the test
const setup = (endpoints: Arr.NonEmptyReadonlyArray<readonly [provider: string, cases: ReadonlyArray<string>]>) => {
  const fixtures = new Map(endpoints.map(([provider, cases]) => [provider, cases.map((name) => load(provider, name))]))
  const served: Array<string> = []
  const unmatched: Array<string> = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const provider = new URL(String(input)).hostname.split(".")[0]
    const { method, params } = Schema.decodeUnknownSync(Request)(await new Response(init?.body).text())
    const fixture = fixtures.get(provider)?.find(({ request }) =>
      request.method === method && isDeepStrictEqual(request.params, params)
    )
    if (fixture === undefined) {
      unmatched.push(`${provider} ${method} ${JSON.stringify(params)}`)
      return new Response("no fixture", { status: 599 })
    }
    served.push(`${provider} ${fixture.name}`)
    return new Response(fixture.body, { status: fixture.status })
  }
  const layer = EvmRpc.layer({
    network: "Ethereum",
    endpoints: Arr.map(endpoints, ([name]) => ({ name, url: Redacted.make(`https://${name}.fixture`) })),
    retries: 0
  }).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)))
  const run = <A, E>(f: (rpc: EvmRpc.EvmRpc["Service"]) => Effect.Effect<A, E>) =>
    Effect.gen(function*() {
      const result = yield* Effect.exit(f(yield* EvmRpc.EvmRpc))
      if (unmatched.length > 0) return yield* Effect.die(new Error(`no fixture for: ${unmatched.join(", ")}`))
      return yield* result
    }).pipe(Effect.provide(layer))
  return { served, run }
}

const EUTBL = EvmAddress.make("0xa0769f7a8fc65e47de93797b4e21c073c117fc80")
const USTBL = EvmAddress.make("0xe4880249745eac5f1ed9d8f7df844792d560e750")
const TRANSFER = EvmHexData.make("0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef")
// the pinned inputs of `scripts/record-fixtures.ts`
const FROM = BigInt(26083549)
const TO = BigInt(26083558)
const filter: EvmRpc.EvmLogsFilter = { address: [EUTBL, USTBL], fromBlock: FROM, toBlock: TO, topics: [TRANSFER] }

const expectPinnedLogs = (logs: ReadonlyArray<{ readonly address: string }>) => {
  expect(logs.filter((log) => log.address === USTBL)).toHaveLength(4)
  expect(logs.filter((log) => log.address === EUTBL)).toHaveLength(1)
  expect(logs[0]).toMatchObject({
    address: USTBL,
    blockNumber: FROM,
    logIndex: 1188,
    transactionIndex: 345,
    transactionHash: "0x5b742dac0f3747de0d0196a04c4d821c8e086f06c4b98d024b08ae18ea39678e",
    data: "0x0000000000000000000000000000000000000000000000000000000087c85fac"
  })
  expect(logs[4]).toMatchObject({
    address: EUTBL,
    blockNumber: TO,
    logIndex: 223,
    transactionHash: "0x612a8b9b05284bada2c9dbfe3f3b8031c23fe5b45af0f449c6062df9803cad14",
    data: "0x00000000000000000000000000000000000000000000000000000000002bc891"
  })
}

describe("EvmRpc fixtures", () => {
  for (const provider of ["alchemy", "infura"]) {
    it.effect(`fixture: ${provider} chainId`, () =>
      setup([[provider, ["chainId"]]]).run((rpc) => rpc.chainId).pipe(
        Effect.map((chainId) => expect(chainId).toBe(EvmNetwork.toChainId("Ethereum")))
      ))

    it.effect(`fixture: ${provider} blockNumber`, () =>
      setup([[provider, ["chainId", "blockNumber"]]]).run((rpc) => rpc.blockNumber).pipe(
        // the head moves at each recording: only its position past the pinned range is stable
        Effect.map((head) => expect(head).toBeGreaterThan(TO))
      ))

    it.effect(`fixture: ${provider} getLogs`, () =>
      setup([[provider, ["chainId", "blockNumber", "getLogs"]]]).run((rpc) => rpc.getLogs(filter)).pipe(
        Effect.map(expectPinnedLogs)
      ))

    it.effect(`fixture: ${provider} invalid-params`, () =>
      setup([[provider, ["chainId", "blockNumber", "invalid-params"]]]).run((rpc) =>
        Effect.flip(rpc.getLogs({ ...filter, topics: [[EvmHexData.make("0xab")]] }))
      ).pipe(Effect.map((error) => expect(error).toMatchObject({ reason: "Rejected", code: -32602 }))))

    it.effect(`fixture: ${provider} invalid-key`, () =>
      setup([[provider, ["invalid-key"]]]).run((rpc) => Effect.flip(rpc.chainId)).pipe(
        Effect.map((error) => expect(error).toMatchObject({ reason: "Unavailable", code: 401 }))
      ))

    // the provider's own reply (Alchemy -32602 "block range extends beyond current head block", Infura an empty `[]`)
    // is never requested: the head guard fails Lagging first
    it.effect(`fixture: ${provider} getLogs-beyond-head`, () => {
      const { run, served } = setup([[provider, ["chainId", "blockNumber", "getLogs-beyond-head"]]])
      return run((rpc) =>
        Effect.flip(rpc.getLogs({ ...filter, fromBlock: BigInt(0xfffffff6), toBlock: BigInt(0xffffffff) }))
      )
        .pipe(Effect.map((error) => {
          expect(error).toMatchObject({ reason: "Lagging", method: "eth_getLogs" })
          expect(served).toStrictEqual([`${provider} chainId`, `${provider} blockNumber`])
        }))
    })
  }

  // Alchemy answers HTTP 400 (-32600 "Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block
  // range..."): the status makes it Unavailable and the call falls back
  it.effect("fixture: alchemy getLogs-range-too-large", () =>
    setup([["alchemy", ["chainId", "blockNumber", "getLogs-range-too-large"]]]).run((rpc) =>
      Effect.flip(rpc.getLogs({ ...filter, fromBlock: TO - BigInt(10009) }))
    ).pipe(Effect.map((error) => expect(error).toMatchObject({ reason: "Unavailable", code: 400 }))))

  // gap: Infura answers HTTP 200 -32602 "range 10009 exceeds limit of 10000", a provider limit another endpoint may not
  // have, yet -32602 maps to Rejected and stops the fallback. Expected Unavailable
  it.fails("fixture: infura getLogs-range-too-large", () =>
    Effect.runPromise(
      setup([["infura", ["chainId", "blockNumber", "getLogs-range-too-large"]]]).run((rpc) =>
        Effect.flip(rpc.getLogs({ ...filter, fromBlock: TO - BigInt(10009) }))
      ).pipe(Effect.map((error) => expect(error).toMatchObject({ reason: "Unavailable", code: -32602 })))
    ))

  it.effect("fixture: alchemy invalid-key falls back to infura getLogs", () => {
    const { run, served } = setup([["alchemy", ["invalid-key"]], ["infura", ["chainId", "blockNumber", "getLogs"]]])
    return run((rpc) => rpc.getLogs(filter)).pipe(Effect.map((logs) => {
      expectPinnedLogs(logs)
      expect(served).toStrictEqual(["alchemy invalid-key", "infura chainId", "infura blockNumber", "infura getLogs"])
    }))
  })
})
