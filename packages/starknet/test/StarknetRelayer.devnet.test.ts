import { StarknetAddress } from "@effect-blockchain/starknet/StarknetAddress"
import { STRK_TOKEN_ADDRESS } from "@effect-blockchain/starknet/StarknetNetwork"
import * as StarknetRelayer from "@effect-blockchain/starknet/StarknetRelayer"
import * as StarknetRpc from "@effect-blockchain/starknet/StarknetRpc"
import * as StarknetSigner from "@effect-blockchain/starknet/StarknetSigner"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import { ec, hash, stark } from "starknet"

// runs against a local devnet (`starknet-devnet --seed 0`, then
// `STARKNET_DEVNET_RPC_URL=http://127.0.0.1:5050 pnpm vitest run`), skipped otherwise
const url = process.env.STARKNET_DEVNET_RPC_URL ?? ""

// the first two accounts `starknet-devnet --seed 0` predeploys and prints, and the OpenZeppelin account class it
// declares for them: https://0xspaceshard.github.io/starknet-devnet/docs/predeployed
const KEY = "0x71d7bb07b9a64f6f78ac4c816aff4da9"
const ADDRESS = StarknetAddress.make("0x064b48806902a367c8598f4f95c305e8c1a1acba5f082d294a43793113115691")
const OTHER_KEY = "0xa20a02f0ac53692d144b20cb371a60d7"
const TO = StarknetAddress.make("0x049dfb8ce986e21d354ac93ea65e6a11f639c1934ea253e5ff14ca62eca0f38e")
const ACCOUNT_CLASS_HASH = "0x05b4b537eaa2399e3aa99c4e2e0208ebd6c71bc1467938cd52c798c601e43564"

const STRK = BigInt("1000000000000000000")

// `transfer(recipient, amount)` of the STRK token, the amount being a u256 as two felts
const transfer = (to: StarknetAddress, amount: bigint): StarknetRelayer.StarknetCall => ({
  contractAddress: STRK_TOKEN_ADDRESS,
  entrypoint: "transfer",
  calldata: [to, `0x${amount.toString(16)}`, "0x0"]
})

const layer = StarknetRelayer.layer().pipe(
  // devnet's default chain ID is the one of Sepolia
  Layer.provideMerge(
    StarknetRpc.layer({ network: "StarknetSepolia", endpoints: [{ name: "devnet", url: Redacted.make(url) }] })
  ),
  Layer.provide(FetchHttpClient.layer)
)

const poll = Schedule.spaced("50 millis")

// one sender: the tests share its nonce
describe.skipIf(url === "")("StarknetRelayer on starknet-devnet", { concurrent: false }, () => {
  it.live("signs, broadcasts and confirms an STRK transfer", () =>
    Effect.gen(function*() {
      const relayer = yield* StarknetRelayer.StarknetRelayer
      const rpc = yield* StarknetRpc.StarknetRpc
      const signer = yield* StarknetSigner.fromPrivateKey({ address: ADDRESS, key: Redacted.make(KEY) })
      const next = yield* rpc.getNonce({ address: ADDRESS, blockTag: "latest" })
      const { hash, nonce, signed } = yield* relayer.sign({ signer, calls: [transfer(TO, BigInt(1))] })
      expect(nonce).toBe(next)
      expect(yield* relayer.fetchTransactionStatus({ hash })).toStrictEqual({ _tag: "NotFound" })
      expect(yield* relayer.broadcast({ signed })).toBe(hash)
      const status = yield* relayer.awaitConfirmation({ hash, poll })
      const receipt = yield* rpc.getTransactionReceipt({ transactionHash: hash })
      expect(status).toStrictEqual({ _tag: "Confirmed", block: receipt.blockNumber })
      expect(receipt.events.some((event) => event.fromAddress === STRK_TOKEN_ADDRESS)).toBe(true)
      expect(yield* rpc.getNonce({ address: ADDRESS, blockTag: "latest" })).toBe(next + BigInt(1))
      // the transaction is in a block: its second copy is a success
      expect(yield* relayer.broadcast({ signed })).toBe(hash)
    }).pipe(Effect.provide(layer)))

  it.live("reports a reverted call as Failed", () =>
    Effect.gen(function*() {
      const relayer = yield* StarknetRelayer.StarknetRelayer
      const signer = yield* StarknetSigner.fromPrivateKey({ address: ADDRESS, key: Redacted.make(KEY) })
      // more STRK than the account holds
      const calls = [transfer(TO, STRK * STRK)]
      // the estimate runs the calls: it refuses the ones that revert
      expect(yield* Effect.flip(relayer.sign({ signer, calls }))).toMatchObject({
        _tag: "StarknetRpcError",
        reason: { _tag: "Rejected" },
        code: 41
      })
      const { signed: { resourceBounds } } = yield* relayer.sign({ signer, calls: [transfer(TO, BigInt(1))] })
      const { hash, signed } = yield* relayer.sign({ signer, calls, resourceBounds })
      yield* relayer.broadcast({ signed })
      const status = yield* relayer.awaitConfirmation({ hash, poll })
      expect(status).toMatchObject({ _tag: "Failed", reason: expect.any(String) })
    }).pipe(Effect.provide(layer)))

  it.live("maps a refusal to its reason", () =>
    Effect.gen(function*() {
      const relayer = yield* StarknetRelayer.StarknetRelayer
      const signer = yield* StarknetSigner.fromPrivateKey({ address: ADDRESS, key: Redacted.make(KEY) })
      const calls = [transfer(TO, BigInt(1))]
      const refusal = (signed: StarknetRelayer.StarknetSignedTransaction) =>
        Effect.map(Effect.flip(relayer.broadcast(signed)), (error) => "reason" in error ? error.reason._tag : error)

      // explicit bounds: the estimate refuses a nonce that is not the next one
      const { signed: { resourceBounds } } = yield* relayer.sign({ signer, calls })
      const used = yield* relayer.sign({
        signer,
        calls: [transfer(TO, BigInt(2))],
        resourceBounds,
        nonce: BigInt(0)
      })
      expect(yield* refusal(used)).toBe("InvalidNonce")

      const unaffordable = yield* relayer.sign({
        signer,
        calls,
        resourceBounds: { ...resourceBounds, l2Gas: { ...resourceBounds.l2Gas, maxPricePerUnit: STRK } }
      })
      expect(yield* refusal(unaffordable)).toBe("InsufficientBalance")

      const stranger = yield* StarknetSigner.fromPrivateKey({ address: ADDRESS, key: Redacted.make(OTHER_KEY) })
      const forged = yield* relayer.sign({ signer: stranger, calls })
      expect(yield* refusal(forged)).toBe("ValidationFailure")
    }).pipe(Effect.provide(layer)))

  it.live("deploys a fresh OpenZeppelin account, which then sends", () =>
    Effect.gen(function*() {
      const relayer = yield* StarknetRelayer.StarknetRelayer
      const rpc = yield* StarknetRpc.StarknetRpc
      const funder = yield* StarknetSigner.fromPrivateKey({ address: ADDRESS, key: Redacted.make(KEY) })
      const key = stark.randomAddress()
      const publicKey = ec.starkCurve.getStarkKey(key)
      const account = { classHash: ACCOUNT_CLASS_HASH, salt: publicKey, constructorCalldata: [publicKey] }
      const address = Schema.decodeSync(StarknetAddress)(
        hash.calculateContractAddressFromHash(account.salt, account.classHash, account.constructorCalldata, 0)
      )
      const signer = yield* StarknetSigner.fromPrivateKey({ address, key: Redacted.make(key) })

      // the address pays for its own deployment
      const funding = yield* relayer.sign({ signer: funder, calls: [transfer(address, STRK)] })
      yield* relayer.broadcast(funding)
      expect(yield* relayer.awaitConfirmation({ hash: funding.hash, poll })).toMatchObject({ _tag: "Confirmed" })

      expect(yield* Effect.flip(relayer.signDeployAccount({ signer, ...account, salt: "0x1" }))).toBeInstanceOf(
        StarknetSigner.StarknetSignerError
      )
      const deployment = yield* relayer.signDeployAccount({ signer, ...account })
      expect(deployment.nonce).toBe(BigInt(0))
      expect(yield* relayer.broadcast(deployment)).toBe(deployment.hash)
      expect(yield* relayer.awaitConfirmation({ hash: deployment.hash, poll })).toMatchObject({ _tag: "Confirmed" })
      expect(yield* rpc.getNonce({ address, blockTag: "latest" })).toBe(BigInt(1))
      expect(yield* relayer.broadcast(deployment)).toBe(deployment.hash)

      const sent = yield* relayer.sign({ signer, calls: [transfer(TO, BigInt(1))] })
      expect(sent.nonce).toBe(BigInt(1))
      yield* relayer.broadcast(sent)
      expect(yield* relayer.awaitConfirmation({ hash: sent.hash, poll })).toMatchObject({ _tag: "Confirmed" })
    }).pipe(Effect.provide(layer)))
})
