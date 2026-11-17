import { EvmAddress } from "@effect-blockchain/evm/EvmAddress"
import { EvmHexData } from "@effect-blockchain/evm/EvmHexData"
import * as EvmNetwork from "@effect-blockchain/evm/EvmNetwork"
import * as EvmSigner from "@effect-blockchain/evm/EvmSigner"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import { sign } from "viem/accounts"

// Anvil's first two development accounts: public keys, never funded on a real network
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
const ADDRESS = EvmAddress.make("0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266")
const OTHER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
const OTHER = EvmAddress.make("0x70997970c51812dc3a010c7d01b50e0d17dc79c8")

const transaction: EvmSigner.EvmUnsignedTransaction = {
  chainId: EvmNetwork.toChainId("Anvil"),
  nonce: BigInt(0),
  to: OTHER,
  value: BigInt("1000000000000000000"),
  gas: BigInt(21000),
  maxFeePerGas: BigInt(2_000_000_000),
  maxPriorityFeePerGas: BigInt(1_000_000_000)
}
// viem 2.57.11: `privateKeyToAccount(KEY).signTransaction` of `transaction` as an `eip1559` transaction
const SIGNED =
  "0x02f874827a6980843b9aca0084773594008252089470997970c51812dc3a010c7d01b50e0d17dc79c8880de0b6b3a764000080c080a074128fd7d42631897474d93692787a2e56b813754468caaca4993c641c986a37a06d5a3b027177cc2841199b70400fece0a29ac5eabee2fa9cbf9b6aa213716c48"

const hashSigner = (key: `0x${string}`, address = ADDRESS) =>
  EvmSigner.fromHashSigner({
    address,
    signHash: (hash) =>
      Effect.promise(() => sign({ hash, privateKey: key, to: "hex" })).pipe(Effect.map((hex) => EvmHexData.make(hex)))
  })

describe("EvmSigner", () => {
  it.effect("fromPrivateKey signs the EIP-1559 serialization", () =>
    Effect.gen(function*() {
      const signer = yield* EvmSigner.fromPrivateKey({ key: Redacted.make(KEY) })
      expect(signer.address).toBe(ADDRESS)
      expect(yield* signer.signTransaction(transaction)).toBe(SIGNED)
      // `value` and `data` default to 0 and `0x`
      expect(yield* signer.signTransaction({ ...transaction, value: undefined })).toBe(
        yield* signer.signTransaction({ ...transaction, value: BigInt(0), data: EvmHexData.make("0x") })
      )
    }))

  it.effect("fromPrivateKey fails on an invalid key without repeating it", () =>
    Effect.gen(function*() {
      for (const key of ["not a key", "0x1234"]) {
        const error = yield* Effect.flip(EvmSigner.fromPrivateKey({ key: Redacted.make(key) }))
        expect(error).toBeInstanceOf(EvmSigner.EvmSignerError)
        expect(String(error.cause)).toBe("Error: invalid private key")
      }
    }))

  it.effect("fromPrivateKey fails on a transaction that does not serialize", () =>
    Effect.gen(function*() {
      const signer = yield* EvmSigner.fromPrivateKey({ key: Redacted.make(KEY) })
      const error = yield* Effect.flip(
        signer.signTransaction({ ...transaction, maxPriorityFeePerGas: transaction.maxFeePerGas + BigInt(1) })
      )
      expect(error._tag).toBe("EvmSignerError")
    }))

  it.effect("fromHashSigner assembles the same signed transaction from a hash signature", () =>
    hashSigner(KEY).signTransaction(transaction).pipe(Effect.map((signed) => expect(signed).toBe(SIGNED))))

  it.effect("fromHashSigner fails with the signer's failure as the cause", () =>
    EvmSigner.fromHashSigner({ address: ADDRESS, signHash: () => Effect.fail("policy denied") }).signTransaction(
      transaction
    ).pipe(
      Effect.flip,
      Effect.map((error) => expect(error).toMatchObject({ _tag: "EvmSignerError", cause: "policy denied" }))
    ))

  it.effect("fromHashSigner refuses a signature from another key, a malformed one and a bad transaction", () =>
    Effect.gen(function*() {
      const wrongKey = yield* Effect.flip(hashSigner(OTHER_KEY).signTransaction(transaction))
      expect(String(wrongKey.cause)).toMatch(/^Error: signed by 0x70997970.* expected 0xf39fd6e5/u)
      const malformed = EvmSigner.fromHashSigner({
        address: ADDRESS,
        signHash: () => Effect.succeed(EvmHexData.make("0x1234"))
      })
      expect((yield* Effect.flip(malformed.signTransaction(transaction)))._tag).toBe("EvmSignerError")
      const unrecoverable = EvmSigner.fromHashSigner({
        address: ADDRESS,
        signHash: () => Effect.succeed(EvmHexData.make(`0x${"00".repeat(64)}1b`))
      })
      expect((yield* Effect.flip(unrecoverable.signTransaction(transaction)))._tag).toBe("EvmSignerError")
      const overpriced = { ...transaction, maxPriorityFeePerGas: transaction.maxFeePerGas + BigInt(1) }
      expect((yield* Effect.flip(hashSigner(KEY).signTransaction(overpriced)))._tag).toBe("EvmSignerError")
    }))
})
