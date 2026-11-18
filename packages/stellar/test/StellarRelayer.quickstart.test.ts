import { StellarAccountAddress } from "@effect-blockchain/stellar/StellarAddress"
import * as StellarRelayer from "@effect-blockchain/stellar/StellarRelayer"
import * as StellarRpc from "@effect-blockchain/stellar/StellarRpc"
import * as StellarSigner from "@effect-blockchain/stellar/StellarSigner"
import { describe, expect, it } from "@effect/vitest"
import { Address, Asset, Keypair, nativeToScVal, Networks, Operation, StrKey, xdr } from "@stellar/stellar-sdk"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schedule from "effect/Schedule"
import { accountEntry as decodeAccount } from "../src/internal/accountChange.ts"
import { accountKey } from "./utils/ledgerMeta.ts"

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
  Operation.payment({ destination, asset: Asset.native(), amount }).toXdr("base64")

const layer = StellarRelayer.layer().pipe(
  Layer.provideMerge(
    StellarRpc.layer({ network: "StellarStandalone", endpoints: [{ name: "quickstart", url: Redacted.make(url) }] })
  ),
  Layer.provide(FetchHttpClient.layer)
)

const poll = Schedule.spaced("200 millis")

const accountEntry = (address: string) =>
  Effect.gen(function*() {
    const rpc = yield* StellarRpc.StellarRpc
    const { entries } = yield* rpc.getLedgerEntries({ keys: [accountKey(address).toXdr("base64")] })
    return decodeAccount(entries[0]?.xdr ?? "")
  })

// one sender: the tests share its sequence number
describe.skipIf(url === "")("StellarRelayer on quickstart", { concurrent: false, timeout: 60_000 }, () => {
  it.live("signs, broadcasts and confirms a payment", () =>
    Effect.gen(function*() {
      const relayer = yield* StellarRelayer.StellarRelayer
      const rpc = yield* StellarRpc.StellarRpc
      const signer = yield* StellarSigner.fromPrivateKey({ key: Redacted.make(sender.secret()) })
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
      const signer = yield* StellarSigner.fromPrivateKey({ key: Redacted.make(sender.secret()) })
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
      const signer = yield* StellarSigner.fromPrivateKey({ key: Redacted.make(sender.secret()) })
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
      const signer = yield* StellarSigner.fromPrivateKey({ key: Redacted.make(sender.secret()) })
      const operations = [payment(receiver, "1")] as const
      const used = yield* relayer.sign({ signer, operations, sequence: BigInt(1) })
      expect(yield* Effect.flip(relayer.broadcast({ signed: used.signed }))).toMatchObject({
        _tag: "StellarBroadcastError",
        reason: { _tag: "InvalidNonce" }
      })
      const cheap = yield* relayer.sign({ signer, operations, fees: { fee: BigInt(1) } })
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

  it.live("signs, broadcasts and confirms a contract invocation", () =>
    Effect.gen(function*() {
      const relayer = yield* StellarRelayer.StellarRelayer
      const signer = yield* StellarSigner.fromPrivateKey({ key: Redacted.make(sender.secret()) })
      const send = Effect.fnUntraced(function*(operation: string) {
        const { hash, maxLedger, signed } = yield* relayer.sign({ signer, operations: [operation] })
        yield* relayer.broadcast({ signed })
        return yield* relayer.awaitConfirmation({ hash, maxLedger, poll })
      })
      // the contract of the native asset: creating it is an invocation too, which fails once it exists
      yield* Effect.ignore(send(Operation.createStellarAssetContract({ asset: Asset.native() }).toXdr("base64")))
      const call = (name: string, from: string) =>
        Operation.invokeContractFunction({
          contract: Asset.native().contractId(Networks.STANDALONE),
          function: name,
          args: [new Address(from).toScVal(), new Address(receiver).toScVal(), nativeToScVal(1, { type: "i128" })]
        }).toXdr("base64")
      expect(yield* send(call("transfer", signer.address))).toMatchObject({ _tag: "Confirmed" })
      expect(yield* Effect.flip(send(call("transfer", receiver)))).toMatchObject({
        _tag: "StellarSimulationError",
        reason: { _tag: "UnsupportedAuth" }
      })
      expect(yield* Effect.flip(send(call("missing", signer.address)))).toMatchObject({
        _tag: "StellarSimulationError",
        reason: { _tag: "SimulationFailed" }
      })
    }).pipe(Effect.provide(layer)))

  it.live("confirms a transaction wrapped in a fee bump paid by another account", () =>
    Effect.gen(function*() {
      const relayer = yield* StellarRelayer.StellarRelayer
      const rpc = yield* StellarRpc.StellarRpc
      const signer = yield* StellarSigner.fromPrivateKey({ key: Redacted.make(sender.secret()) })
      const payer = yield* StellarSigner.fromPrivateKey({ key: Redacted.make(Keypair.random().secret()) })
      yield* fund(payer.address)
      const inner = yield* relayer.sign({ signer, operations: [payment(receiver, "1")] })
      const bumped = yield* relayer.feeBump({ signer: payer, signed: inner.signed })
      const { hash } = bumped
      expect([bumped.sequence, bumped.maxLedger]).toStrictEqual([inner.sequence, inner.maxLedger])
      expect(yield* relayer.broadcast(bumped)).toBe(hash)
      const status = yield* relayer.awaitConfirmation({ ...bumped, poll })
      expect(status).toMatchObject({ _tag: "Confirmed" })
      expect(yield* rpc.getTransaction({ hash })).toMatchObject({ status: "SUCCESS", feeBump: true })
    }).pipe(Effect.provide(layer)))

  it.live("sends two payments of one account at once through two channels, one wrapped in a fee bump", () =>
    Effect.gen(function*() {
      const relayer = yield* StellarRelayer.StellarRelayer
      const signer = yield* StellarSigner.fromPrivateKey({ key: Redacted.make(sender.secret()) })
      const channels = yield* Effect.forEach(
        [Keypair.random(), Keypair.random()],
        (channel) => StellarSigner.fromPrivateKey({ key: Redacted.make(channel.secret()) })
      )
      yield* Effect.forEach(channels, (channel) => fund(channel.address), { concurrency: 2 })
      const before = yield* accountEntry(signer.address)
      const operations = [payment(receiver, "1")] as const
      const [direct, wrapped] = yield* Effect.forEach(
        channels,
        (channel) => relayer.sign({ signer, channel, operations }),
        { concurrency: 2 }
      )
      const bumped = yield* relayer.feeBump({ signer, signed: wrapped.signed })
      yield* Effect.all([relayer.broadcast(direct), relayer.broadcast(bumped)], { concurrency: 2 })
      expect(
        yield* Effect.all([
          relayer.awaitConfirmation({ ...direct, poll }),
          relayer.awaitConfirmation({ ...bumped, poll })
        ], { concurrency: 2 })
      ).toMatchObject([{ _tag: "Confirmed" }, { _tag: "Confirmed" }])
      const after = yield* accountEntry(signer.address)
      // both payments left the account, whose sequence number did not move
      expect(after.seqNum).toBe(before.seqNum)
      // 2 stroops paid, and the fee of the fee bump: 100 stroops for the payment and 100 for the bump
      expect(after.balance).toBe(before.balance - BigInt(20_000_200))
    }).pipe(Effect.provide(layer)))

  it.live("creates an account whose reserve is paid by its sponsor", () =>
    Effect.gen(function*() {
      const relayer = yield* StellarRelayer.StellarRelayer
      const rpc = yield* StellarRpc.StellarRpc
      const signer = yield* StellarSigner.fromPrivateKey({ key: Redacted.make(sender.secret()) })
      const account = yield* StellarSigner.fromPrivateKey({ key: Redacted.make(Keypair.random().secret()) })
      const { hash, maxLedger, signed } = yield* relayer.sign({
        signer,
        operations: StellarRelayer.createSponsoredAccount({ sponsor: signer.address, account: account.address }),
        cosigners: [account]
      })
      yield* relayer.broadcast({ signed })
      expect(yield* relayer.awaitConfirmation({ hash, maxLedger, poll })).toMatchObject({ _tag: "Confirmed" })
      const { entries: [entry] } = yield* rpc.getLedgerEntries({ keys: [accountKey(account.address).toXdr("base64")] })
      expect(decodeAccount(entry?.xdr ?? "").balance).toBe(BigInt(0))
      const ext = xdr.LedgerEntryExt.fromXdr(entry?.extXdr ?? "", "base64")
      const sponsor = ext.type === "v1" ? ext.v1.sponsoringId : null
      expect(sponsor ? StrKey.encodeEd25519PublicKey(sponsor.ed25519.toBytes()) : undefined).toBe(signer.address)
    }).pipe(Effect.provide(layer)))
})
