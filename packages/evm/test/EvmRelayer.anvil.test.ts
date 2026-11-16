import { EvmAddress } from "@effect-blockchain/evm/EvmAddress"
import * as EvmRelayer from "@effect-blockchain/evm/EvmRelayer"
import * as EvmRpc from "@effect-blockchain/evm/EvmRpc"
import * as EvmSigner from "@effect-blockchain/evm/EvmSigner"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"

// runs against a local Anvil (`anvil`, then `ANVIL_RPC_URL=http://127.0.0.1:8545 pnpm vitest run`), skipped otherwise
const url = process.env.ANVIL_RPC_URL ?? ""

// Anvil's first well-known key and second account: https://getfoundry.sh/anvil/overview
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
const TO = Schema.decodeSync(EvmAddress)("0x70997970c51812dc3a010c7d01b50e0d17dc79c8")
const REVERTING = Schema.decodeSync(EvmAddress)("0x" + "5e".repeat(20))

// Anvil's own methods, outside the standard `EvmRpc`
const anvil = (method: string, params: ReadonlyArray<Schema.Json>) =>
  Effect.promise(() =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
    })
  )

const layer = EvmRelayer.layer().pipe(
  Layer.provideMerge(EvmRpc.layer({ network: "Anvil", endpoints: [{ name: "anvil", url: Redacted.make(url) }] })),
  Layer.provide(FetchHttpClient.layer)
)

const poll = Schedule.spaced("50 millis")

// one sender: the tests share its nonce and Anvil's mining mode
describe.skipIf(url === "")("EvmRelayer on Anvil", { concurrent: false }, () => {
  it.live("signs, broadcasts and confirms a value transfer", () =>
    Effect.gen(function*() {
      const relayer = yield* EvmRelayer.EvmRelayer
      const rpc = yield* EvmRpc.EvmRpc
      const signer = yield* EvmSigner.fromPrivateKey(Redacted.make(KEY))
      const count = yield* rpc.getTransactionCount({ address: signer.address, blockTag: "latest" })
      const { hash, nonce, signed } = yield* relayer.sign({ signer, to: TO, value: BigInt(1) })
      expect(nonce).toBe(count)
      expect(yield* relayer.fetchTransactionStatus({ hash })).toStrictEqual({ _tag: "NotFound" })
      expect(yield* relayer.broadcast({ signed })).toBe(hash)
      const status = yield* relayer.awaitConfirmation({ hash, poll })
      const receipt = yield* rpc.getTransactionReceipt({ hash })
      expect(receipt).not.toBeNull()
      expect(status).toStrictEqual({ _tag: "Confirmed", block: receipt?.blockNumber })
      // the transaction is in a block: Anvil answers `nonce too low` to its second copy
      expect(yield* relayer.broadcast({ signed })).toBe(hash)
    }).pipe(Effect.provide(layer)))

  it.live("reports a reverted call as Failed", () =>
    Effect.gen(function*() {
      const relayer = yield* EvmRelayer.EvmRelayer
      const signer = yield* EvmSigner.fromPrivateKey(Redacted.make(KEY))
      // PUSH1 0 PUSH1 0 REVERT
      yield* anvil("anvil_setCode", [REVERTING, "0x60006000fd"])
      const estimated = yield* Effect.flip(relayer.sign({ signer, to: REVERTING }))
      expect(estimated).toMatchObject({ _tag: "EvmRpcError", reason: { _tag: "Rejected" } })
      const { hash, signed } = yield* relayer.sign({ signer, to: REVERTING, gas: BigInt(100_000) })
      yield* relayer.broadcast({ signed })
      expect(yield* relayer.awaitConfirmation({ hash, poll })).toMatchObject({ _tag: "Failed" })
    }).pipe(Effect.provide(layer)))

  it.live("replaces a pending transaction at the same nonce with bumped fees", () =>
    Effect.gen(function*() {
      const relayer = yield* EvmRelayer.EvmRelayer
      const signer = yield* EvmSigner.fromPrivateKey(Redacted.make(KEY))
      yield* anvil("evm_setAutomine", [false])
      const fees = { maxFeePerGas: BigInt(10_000_000_000), maxPriorityFeePerGas: BigInt(1_000_000_000) }
      const stuck = yield* relayer.sign({ signer, to: TO, value: BigInt(1), fees })
      yield* relayer.broadcast({ signed: stuck.signed })
      expect(yield* relayer.fetchTransactionStatus({ hash: stuck.hash })).toStrictEqual({ _tag: "Pending" })
      expect(yield* relayer.broadcast({ signed: stuck.signed })).toBe(stuck.hash)

      const same = yield* relayer.sign({ signer, to: TO, value: BigInt(2), nonce: stuck.nonce, fees })
      const refused = yield* Effect.flip(relayer.broadcast({ signed: same.signed }))
      expect(refused).toMatchObject({ _tag: "EvmBroadcastError", reason: { _tag: "ReplacementUnderpriced" } })

      const bumped = yield* relayer.sign({
        signer,
        to: TO,
        value: BigInt(2),
        nonce: stuck.nonce,
        fees: {
          maxFeePerGas: fees.maxFeePerGas * BigInt(2),
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas * BigInt(2)
        }
      })
      yield* relayer.broadcast({ signed: bumped.signed })
      yield* anvil("evm_mine", [])
      expect(yield* relayer.awaitConfirmation({ hash: bumped.hash, poll })).toMatchObject({ _tag: "Confirmed" })
      expect(yield* relayer.fetchTransactionStatus({ hash: stuck.hash })).toStrictEqual({ _tag: "NotFound" })

      const poor = yield* relayer.sign({
        signer,
        to: TO,
        value: BigInt(10) ** BigInt(24),
        gas: BigInt(21000),
        fees
      })
      const unfunded = yield* Effect.flip(relayer.broadcast({ signed: poor.signed }))
      expect(unfunded).toMatchObject({ _tag: "EvmBroadcastError", reason: { _tag: "InsufficientFunds" } })
    }).pipe(Effect.ensuring(anvil("evm_setAutomine", [true])), Effect.provide(layer)))
})
