import { StellarAccountAddress } from "@effect-blockchain/stellar/StellarAddress"
import * as StellarRelayer from "@effect-blockchain/stellar/StellarRelayer"
import * as StellarRpc from "@effect-blockchain/stellar/StellarRpc"
import * as StellarSigner from "@effect-blockchain/stellar/StellarSigner"
import { describe, expect, it } from "@effect/vitest"
import { Asset, Keypair, Operation } from "@stellar/stellar-sdk"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schedule from "effect/Schedule"

// runs against a local network (`docker run -p 8000:8000 stellar/quickstart --local --enable rpc`, then
// `QUICKSTART_RPC_URL=http://127.0.0.1:8000/rpc pnpm vitest run`), skipped otherwise
const url = process.env.QUICKSTART_RPC_URL ?? ""

// fresh keys, funded by the local friendbot only
const sender = Keypair.random()
const receiver = StellarAccountAddress.make(Keypair.random().publicKey())
const fund = (address: string) =>
  Effect.promise(async () => {
    const response = await fetch(new URL(`/friendbot?addr=${address}`, url))
    if (!response.ok) throw new Error(`friendbot did not fund ${address}`)
  })

const payment = (destination: string, amount: string) =>
  Operation.payment({ destination, asset: Asset.native(), amount }).toXDR("base64")

const layer = StellarRelayer.layer().pipe(
  Layer.provideMerge(
    StellarRpc.layer({ network: "StellarStandalone", endpoints: [{ name: "quickstart", url: Redacted.make(url) }] })
  ),
  Layer.provide(FetchHttpClient.layer)
)

const poll = Schedule.spaced("200 millis")

// one sender: the tests share its sequence number
describe.skipIf(url === "")("StellarRelayer on quickstart", { concurrent: false, timeout: 60_000 }, () => {
  it.live("signs, broadcasts and confirms a payment", () =>
    Effect.gen(function*() {
      const relayer = yield* StellarRelayer.StellarRelayer
      const rpc = yield* StellarRpc.StellarRpc
      const signer = yield* StellarSigner.fromPrivateKey(Redacted.make(sender.secret()))
      yield* Effect.all([fund(signer.address), fund(receiver)])
      const { hash, maxLedger, sequence, signed } = yield* relayer.sign({
        signer,
        operations: [payment(receiver, "1")]
      })
      expect(yield* relayer.fetchTransactionStatus({ hash, maxLedger })).toStrictEqual({ _tag: "NotFound" })
      expect(yield* relayer.broadcast({ signed })).toBe(hash)
      // the node holds the transaction until its ledger closes
      expect(yield* relayer.broadcast({ signed })).toBe(hash)
      const status = yield* relayer.awaitConfirmation({ hash, maxLedger, poll })
      const transaction = yield* rpc.getTransaction({ hash })
      expect(transaction).toMatchObject({ status: "SUCCESS" })
      expect(status).toMatchObject({ _tag: "Confirmed", block: "ledger" in transaction ? transaction.ledger : 0 })
      // the transaction is in a ledger: the node refuses its second copy
      expect(yield* relayer.broadcast({ signed })).toBe(hash)
      const next = yield* relayer.sign({ signer, operations: [payment(receiver, "1")], maxLedger })
      expect(next.sequence).toBe(sequence + BigInt(1))
    }).pipe(Effect.provide(layer)))

  it.live("reports a failing operation as Failed with its codes", () =>
    Effect.gen(function*() {
      const relayer = yield* StellarRelayer.StellarRelayer
      const signer = yield* StellarSigner.fromPrivateKey(Redacted.make(sender.secret()))
      const { hash, maxLedger, signed } = yield* relayer.sign({
        signer,
        operations: [payment(receiver, "1"), payment(Keypair.random().publicKey(), "1")]
      })
      yield* relayer.broadcast({ signed })
      expect(yield* relayer.awaitConfirmation({ hash, maxLedger, poll })).toMatchObject({
        _tag: "Failed",
        reason: { code: "txFailed", operations: ["paymentSuccess", "paymentNoDestination"] }
      })
    }).pipe(Effect.provide(layer)))

  it.live("reports a transaction that was never sent as Expired after maxLedger", () =>
    Effect.gen(function*() {
      const relayer = yield* StellarRelayer.StellarRelayer
      const rpc = yield* StellarRpc.StellarRpc
      const signer = yield* StellarSigner.fromPrivateKey(Redacted.make(sender.secret()))
      const { latestLedger } = yield* rpc.getFeeStats
      const { hash, maxLedger } = yield* relayer.sign({
        signer,
        operations: [payment(receiver, "1")],
        maxLedger: latestLedger + BigInt(1)
      })
      expect(yield* relayer.awaitConfirmation({ hash, maxLedger, poll })).toStrictEqual({ _tag: "Expired" })
    }).pipe(Effect.provide(layer)))

  it.live("fails a refused transaction with its result code", () =>
    Effect.gen(function*() {
      const relayer = yield* StellarRelayer.StellarRelayer
      const signer = yield* StellarSigner.fromPrivateKey(Redacted.make(sender.secret()))
      const operations = [payment(receiver, "1")] as const
      const used = yield* relayer.sign({ signer, operations, sequence: BigInt(1) })
      expect(yield* Effect.flip(relayer.broadcast({ signed: used.signed }))).toMatchObject({
        _tag: "StellarBroadcastError",
        reason: { _tag: "Refused", code: "txBadSeq" }
      })
      const cheap = yield* relayer.sign({ signer, operations, fee: BigInt(1) })
      expect(yield* Effect.flip(relayer.broadcast({ signed: cheap.signed }))).toMatchObject({
        _tag: "StellarBroadcastError",
        reason: { _tag: "Refused", code: "txInsufficientFee" }
      })
      const late = yield* relayer.sign({ signer, operations, maxLedger: BigInt(1) })
      expect(yield* Effect.flip(relayer.broadcast({ signed: late.signed }))).toMatchObject({
        _tag: "StellarBroadcastError",
        reason: { _tag: "Refused", code: "txTooLate" }
      })
    }).pipe(Effect.provide(layer)))
})
