import { StarknetAddress } from "@effect-blockchain/starknet/StarknetAddress"
import * as StarknetRpc from "@effect-blockchain/starknet/StarknetRpc"
import { StarknetTransactionHash } from "@effect-blockchain/starknet/StarknetTransactionHash"
import { describe, expect, it } from "@effect/vitest"
import * as Arr from "effect/Array"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { isDeepStrictEqual } from "node:util"

// real provider replies recorded by `scripts/record-fixtures.ts`
const Fixture = Schema.fromJsonString(Schema.Struct({
  provider: Schema.String,
  network: Schema.String,
  recordedAt: Schema.String,
  request: Schema.Struct({ method: Schema.String, params: Schema.Json }),
  status: Schema.Number,
  body: Schema.String
}))
type Fixture = typeof Fixture.Type

const providers = ["alchemy", "infura"] as const
type Provider = typeof providers[number]

const load = (provider: Provider, name: string): Fixture =>
  Schema.decodeUnknownSync(Fixture)(
    readFileSync(join(import.meta.dirname, "fixtures", provider, `${name}.json`), "utf8")
  )

// one replay fetch serving every endpoint `https://<provider>.fixture`, from that endpoint's fixtures only
const replay = (endpoints: Partial<Record<Provider, ReadonlyArray<string>>>) => {
  const fixtures = new Map(
    Object.entries(endpoints).map((
      [provider, names]
    ) => [provider, names.map((name) => load(provider as Provider, name))])
  )
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const provider = new URL(String(input)).hostname.split(".")[0]
    const { method, params }: { method: string; params: Schema.Json } = JSON.parse(
      await new Response(init?.body).text()
    )
    const fixture = fixtures.get(provider)?.find((fixture) =>
      fixture.request.method === method && isDeepStrictEqual(fixture.request.params, params)
    )
    if (fixture === undefined) throw new Error(`no ${provider} fixture for ${method} ${JSON.stringify(params)}`)
    return new Response(fixture.body, { status: fixture.status, headers: { "content-type": "application/json" } })
  }
  const names = Array.from(fixtures.keys())
  if (!Arr.isReadonlyArrayNonEmpty(names)) throw new Error("replay needs at least one endpoint")
  const layer = StarknetRpc.layer({
    network: "Starknet",
    endpoints: Arr.map(names, (name) => ({ name, url: Redacted.make(`https://${name}.fixture`) })),
    retries: 0
  }).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)))
  return <A, E>(f: (rpc: StarknetRpc.StarknetRpc["Service"]) => Effect.Effect<A, E>) =>
    Effect.gen(function*() {
      return yield* f(yield* StarknetRpc.StarknetRpc)
    }).pipe(Effect.provide(layer))
}

// the pinned inputs of the recorder
const EUTBL = StarknetAddress.make("0x04f5e0de717daa6aa8de63b1bf2e8d7823ec5b21a88461b1519d9dbc956fb7f2")
const RECEIPT_TX = StarknetTransactionHash.make("0x02aa671ff923b87808ec822766994ed10fd5720d7441798a96fbd770c0b7e9ab")
const PAGE2_TX = StarknetTransactionHash.make("0x02904089bcb25b52af0647bfdfa7032fe48da129d6c4c8b788c845949a9d6953")
const filter = { address: EUTBL, fromBlock: BigInt(1380300), toBlock: BigInt(1380400), chunkSize: 5 }
const TRANSFER = "0x0099cd8bde557814842a3121e8ddfd433a539b8c9f14bf31ebf108d12e6196e9"
const felt = (value: string) => "0x" + value.slice(2).padStart(64, "0")

const network = ["chainId", "blockNumber"]

describe("StarknetRpc fixtures", () => {
  for (const provider of providers) {
    it.effect(`fixture: ${provider} chainId`, () =>
      replay({ [provider]: network })((rpc) => rpc.chainId).pipe(
        Effect.map((chainId) => expect(chainId).toBe("SN_MAIN"))
      ))

    it.effect(`fixture: ${provider} blockNumber`, () =>
      replay({ [provider]: network })((rpc) => rpc.blockNumber).pipe(
        Effect.map((head) => expect(head > BigInt(17_000_000)).toBe(true))
      ))

    it.effect(`fixture: ${provider} getEvents pages`, () =>
      replay({ [provider]: [...network, "getEvents-page-1", "getEvents-page-2"] })((rpc) =>
        Effect.gen(function*() {
          const page1 = yield* rpc.getEvents(filter)
          expect(page1.events).toHaveLength(5)
          expect(page1.events[0]).toMatchObject({
            fromAddress: EUTBL,
            blockNumber: BigInt(1380308),
            transactionHash: RECEIPT_TX,
            keys: [TRANSFER, felt("0x0"), felt("0x7fcb432d3a96521ad376c04e9c3c76d57d649cec9825370b075b31d5174bb2a")],
            data: [felt("0x5dcf7644f"), felt("0x0")]
          })
          expect(page1.cursor).toStrictEqual({ endpoint: provider, cursor: "1380320-1" })

          const page2 = yield* rpc.getEvents({ ...filter, cursor: page1.cursor })
          expect(page2.events).toHaveLength(5)
          expect(page2.events[0]).toMatchObject({ blockNumber: BigInt(1380320), transactionHash: PAGE2_TX })
          expect(page2.cursor).toStrictEqual({ endpoint: provider, cursor: "1380394-2" })
        })
      ))

    it.effect(`fixture: ${provider} getTransactionReceipt`, () =>
      replay({ [provider]: [...network, "getTransactionReceipt"] })((rpc) =>
        rpc.getTransactionReceipt({ transactionHash: RECEIPT_TX })
      ).pipe(Effect.map((receipt) => {
        expect(receipt).toMatchObject({
          transactionHash: RECEIPT_TX,
          blockNumber: BigInt(1380308),
          blockHash: felt("0x67e8337f3fdbb26df8129ba3e3d6e47e790c3687b9a81ab4aed8b6e9711b584")
        })
        expect(receipt.events[0]).toMatchObject({ fromAddress: EUTBL, data: [felt("0x5dcf7644f"), felt("0x0")] })
      })))

    // the provider answers a `to_block` beyond its head with events, no BLOCK_NOT_FOUND (see the recorded
    // `getEvents-beyond-head`): the head guard fails Lagging from the real head before sending it
    it.effect(`fixture: ${provider} getEvents beyond head`, () =>
      replay({ [provider]: network })((rpc) => Effect.flip(rpc.getEvents({ ...filter, toBlock: BigInt(99999999) })))
        .pipe(
          Effect.map((error) =>
            expect(error).toMatchObject({ reason: "Lagging", method: "starknet_getEvents", endpoint: provider })
          )
        ))

    it.effect(`fixture: ${provider} getEvents chunk size too big`, () =>
      replay({ [provider]: [...network, "getEvents-chunk-too-big"] })((rpc) =>
        Effect.flip(rpc.getEvents({ ...filter, chunkSize: 10000 }))
      ).pipe(Effect.map((error) => expect(error).toMatchObject({ reason: "Rejected", code: 31 }))))

    it.effect(`fixture: ${provider} getEvents invalid continuation token`, () =>
      replay({ [provider]: [...network, "getEvents-invalid-token"] })((rpc) =>
        Effect.flip(
          rpc.getEvents({
            ...filter,
            cursor: StarknetRpc.StarknetEventsCursor.make({ endpoint: provider, cursor: "invalid" })
          })
        )
      ).pipe(Effect.map((error) => expect(error).toMatchObject({ reason: "Rejected", code: 33 }))))

    it.effect(`fixture: ${provider} invalid key`, () =>
      replay({ [provider]: ["invalid-key"] })((rpc) => Effect.flip(rpc.chainId)).pipe(
        Effect.map((error) =>
          expect(error).toMatchObject({ reason: "Unavailable", code: 401, method: "starknet_chainId" })
        )
      ))
  }

  it.effect("fixture: alchemy invalid key falls back to infura", () =>
    replay({ alchemy: ["invalid-key"], infura: network })((rpc) => rpc.blockNumber).pipe(
      Effect.map((head) => expect(head).toBe(BigInt(JSON.parse(load("infura", "blockNumber").body).result)))
    ))
})
