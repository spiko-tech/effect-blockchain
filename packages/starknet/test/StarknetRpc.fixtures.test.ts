import * as Replay from "@effect-blockchain/core/test/utils/replay"
import { StarknetAddress } from "@effect-blockchain/starknet/StarknetAddress"
import * as StarknetRpc from "@effect-blockchain/starknet/StarknetRpc"
import { StarknetTransactionHash } from "@effect-blockchain/starknet/StarknetTransactionHash"
import { describe, expect, it } from "@effect/vitest"
import type * as Arr from "effect/Array"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"

// real provider replies recorded by `scripts/record-fixtures.ts`
const fixtures = new URL("fixtures/", import.meta.url)
const providers = ["alchemy", "infura"] as const

const replay = (endpoints: Arr.NonEmptyReadonlyArray<Replay.Endpoint>) => {
  const { check, endpoints: urls, fetch } = Replay.replay(fixtures, endpoints)
  const layer = StarknetRpc.layer({ network: "Starknet", endpoints: urls, retries: 0 }).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))
  )
  return <A, E>(f: (rpc: StarknetRpc.StarknetRpc["Service"]) => Effect.Effect<A, E>) =>
    check(
      Effect.gen(function*() {
        return yield* f(yield* StarknetRpc.StarknetRpc)
      }).pipe(Effect.provide(layer))
    )
}

// the pinned inputs of the recorder
const EUTBL = StarknetAddress.make("0x04f5e0de717daa6aa8de63b1bf2e8d7823ec5b21a88461b1519d9dbc956fb7f2")
const RECEIPT_TX = StarknetTransactionHash.make("0x02aa671ff923b87808ec822766994ed10fd5720d7441798a96fbd770c0b7e9ab")
const PAGE2_TX = StarknetTransactionHash.make("0x02904089bcb25b52af0647bfdfa7032fe48da129d6c4c8b788c845949a9d6953")
const filter = { address: EUTBL, fromBlock: BigInt(1380300), toBlock: BigInt(1380400), chunkSize: 5 }
const TRANSFER = "0x0099cd8bde557814842a3121e8ddfd433a539b8c9f14bf31ebf108d12e6196e9"
const felt = (value: string) => "0x" + value.slice(2).padStart(64, "0")

const STRK = StarknetAddress.make("0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d")
const STAKING = StarknetAddress.make("0x00ca1702e64c81d9a07b86bd2c540188d92a2c73cf5cc0e508d949015e7e84a7")
const BALANCE_OF = "0x02e4263afad30923c891518314c3c95dbe830a16874e8abc5777a9a20b54c76e"
const BLOCK = BigInt(1380308)
// the staking contract's STRK in fri at BLOCK, the u256 low felt (high is 0)
const STAKING_BALANCE = "0xe22138cc9bba4363cc54cf"

const network = ["chainId", "blockNumber"]

describe("StarknetRpc fixtures", () => {
  for (const provider of providers) {
    it.effect(`fixture: ${provider} chainId`, () =>
      replay([{ name: provider, cases: network }])((rpc) => rpc.chainId).pipe(
        Effect.map((chainId) => expect(chainId).toBe("SN_MAIN"))
      ))

    it.effect(`fixture: ${provider} blockNumber`, () =>
      replay([{ name: provider, cases: network }])((rpc) => rpc.blockNumber).pipe(
        Effect.map((head) => expect(head > BigInt(17_000_000)).toBe(true))
      ))

    it.effect(`fixture: ${provider} getEvents pages`, () =>
      replay([{ name: provider, cases: [...network, "getEvents-page-1", "getEvents-page-2"] }])((rpc) =>
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
      replay([{ name: provider, cases: [...network, "getTransactionReceipt"] }])((rpc) =>
        rpc.getTransactionReceipt({ transactionHash: RECEIPT_TX })
      ).pipe(Effect.map((receipt) => {
        expect(receipt).toMatchObject({
          transactionHash: RECEIPT_TX,
          blockNumber: BigInt(1380308),
          blockHash: felt("0x67e8337f3fdbb26df8129ba3e3d6e47e790c3687b9a81ab4aed8b6e9711b584")
        })
        expect(receipt.events[0]).toMatchObject({ fromAddress: EUTBL, data: [felt("0x5dcf7644f"), felt("0x0")] })
      })))

    it.effect(`fixture: ${provider} getBlockWithTxHashes`, () =>
      replay([{ name: provider, cases: [...network, "getBlockWithTxHashes"] }])((rpc) =>
        rpc.getBlockWithTxHashes({ blockNumber: BigInt(1380308) })
      ).pipe(Effect.map((block) => {
        expect(block).toMatchObject({
          blockNumber: BigInt(1380308),
          blockHash: felt("0x67e8337f3fdbb26df8129ba3e3d6e47e790c3687b9a81ab4aed8b6e9711b584"),
          parentHash: felt("0x119939dd0bfabe7f8e15020dc780da3a930fd2bf628ce67c7bb0aa4686d95bf"),
          timestamp: BigInt(1746611705),
          status: "ACCEPTED_ON_L1"
        })
        expect(block.transactions).toHaveLength(90)
        expect(block.transactions).toContain(RECEIPT_TX)
      })))

    // the provider answers a `to_block` beyond its head with events, no BLOCK_NOT_FOUND (see the recorded
    // `getEvents-beyond-head`): the head guard fails Lagging from the real head before sending it
    it.effect(`fixture: ${provider} getEvents beyond head`, () =>
      replay([{ name: provider, cases: network }])((rpc) =>
        Effect.flip(rpc.getEvents({ ...filter, toBlock: BigInt(99999999) }))
      )
        .pipe(
          Effect.map((error) =>
            expect(error).toMatchObject({
              reason: { _tag: "Lagging" },
              method: "starknet_getEvents",
              endpoint: provider
            })
          )
        ))

    it.effect(`fixture: ${provider} getEvents chunk size too big`, () =>
      replay([{ name: provider, cases: [...network, "getEvents-chunk-too-big"] }])((rpc) =>
        Effect.flip(rpc.getEvents({ ...filter, chunkSize: 10000 }))
      ).pipe(Effect.map((error) => expect(error).toMatchObject({ reason: { _tag: "Rejected" }, code: 31 }))))

    it.effect(`fixture: ${provider} getEvents invalid continuation token`, () =>
      replay([{ name: provider, cases: [...network, "getEvents-invalid-token"] }])((rpc) =>
        Effect.flip(
          rpc.getEvents({
            ...filter,
            cursor: StarknetRpc.StarknetEventsCursor.make({ endpoint: provider, cursor: "invalid" })
          })
        )
      ).pipe(Effect.map((error) => expect(error).toMatchObject({ reason: { _tag: "Rejected" }, code: 33 }))))

    it.effect(`fixture: ${provider} call balanceOf`, () =>
      replay([{ name: provider, cases: [...network, "call-balanceOf"] }])((rpc) =>
        rpc.call({
          contractAddress: STRK,
          entryPointSelector: BALANCE_OF,
          calldata: [STAKING],
          blockNumber: BLOCK
        })
      ).pipe(Effect.map((felts) => expect(felts).toStrictEqual([felt(STAKING_BALANCE), felt("0x0")]))))

    it.effect(`fixture: ${provider} getBalance`, () =>
      replay([{ name: provider, cases: [...network, "call-balanceOf"] }])((rpc) =>
        rpc.getBalance({ address: STAKING, blockNumber: BLOCK })
      ).pipe(Effect.map((balance) => expect(balance).toBe(BigInt(STAKING_BALANCE)))))

    it.effect(`fixture: ${provider} call on a missing contract`, () =>
      replay([{ name: provider, cases: [...network, "call-contract-not-found"] }])((rpc) =>
        Effect.flip(rpc.call({
          contractAddress: StarknetAddress.make(felt("0x1")),
          entryPointSelector: BALANCE_OF,
          calldata: [STAKING],
          blockNumber: BLOCK
        }))
      ).pipe(
        Effect.map((error) =>
          expect(error).toMatchObject({ reason: { _tag: "Rejected" }, code: 20, method: "starknet_call" })
        )
      ))

    it.effect(`fixture: ${provider} getBalance beyond head`, () =>
      replay([{ name: provider, cases: network }])((rpc) =>
        Effect.flip(rpc.getBalance({ address: STAKING, blockNumber: BigInt(99999999) }))
      ).pipe(
        Effect.map((error) =>
          expect(error).toMatchObject({ reason: { _tag: "Lagging" }, method: "starknet_call", endpoint: provider })
        )
      ))

    // HTTP 401: Alchemy's JSON-RPC -32600 body is Rejected, Infura's text body is Unavailable
    it.effect(`fixture: ${provider} invalid key`, () =>
      replay([{ name: provider, cases: ["invalid-key"] }])((rpc) => Effect.flip(rpc.chainId)).pipe(
        Effect.map((error) =>
          expect(error).toMatchObject({
            ...(provider === "alchemy"
              ? { reason: { _tag: "Rejected" }, code: -32600 }
              : { reason: { _tag: "Unavailable", status: 401 }, code: 401 }),
            method: "starknet_chainId"
          })
        )
      ))
  }

  it.effect("fixture: alchemy invalid key falls back to infura", () =>
    replay([{ name: "alchemy", cases: ["invalid-key"] }, { name: "infura", cases: network }])((rpc) => rpc.blockNumber)
      .pipe(
        Effect.map((head) =>
          expect(head).toBe(BigInt(JSON.parse(Replay.load(fixtures, "infura", "blockNumber").body).result))
        )
      ))
})
