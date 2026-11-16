import { StellarAccountAddress } from "@effect-blockchain/stellar/StellarAddress"
import * as StellarSigner from "@effect-blockchain/stellar/StellarSigner"
import { describe, expect, it } from "@effect/vitest"
import { Account, Asset, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"

// a throwaway seed, used on no network
const SEED = "SCZANGBA5YHTNYVVV4C3U252E2B6P6F5T3U6MM63WBSBZATAQI3EBTQ4"
const keypair = Keypair.fromSecret(SEED)
const ADDRESS = StellarAccountAddress.make(keypair.publicKey())
const OTHER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2))

const unsigned = () =>
  new TransactionBuilder(new Account(ADDRESS, "41"), { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.payment({ destination: OTHER.publicKey(), asset: Asset.native(), amount: "1" }))
    .setTimeout(0)
    .build()
const envelope = unsigned().toEnvelope().toXDR("base64")
const transaction = { network: "StellarTestnet", envelope } as const

describe("StellarSigner", () => {
  it.effect("fromPrivateKey signs like the SDK", () =>
    Effect.gen(function*() {
      const signer = yield* StellarSigner.fromPrivateKey(Redacted.make(SEED))
      expect(signer.address).toBe(ADDRESS)
      const expected = unsigned()
      expected.sign(keypair)
      expect(yield* signer.signTransaction(transaction)).toBe(expected.toEnvelope().toXDR("base64"))
      // the passphrase is part of what is signed
      expect(yield* signer.signTransaction({ ...transaction, network: "Stellar" })).not.toBe(
        expected.toEnvelope().toXDR("base64")
      )
    }))

  it.effect("fromPrivateKey fails on an invalid seed without repeating it", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(StellarSigner.fromPrivateKey(Redacted.make("SNOTASEED")))
      expect(error._tag).toBe("StellarSignerError")
      expect(JSON.stringify(error) + String(error.cause)).not.toContain("SNOTASEED")
    }))

  it.effect("fromHashSigner hands the transaction hash over and adds the signature", () =>
    Effect.gen(function*() {
      const hashes: Array<string> = []
      const signer = StellarSigner.fromHashSigner({
        address: ADDRESS,
        signHash: (hash) => {
          hashes.push(hash)
          return Effect.succeed(new Uint8Array(keypair.sign(Buffer.from(hash.slice(2), "hex"))))
        }
      })
      const signed = TransactionBuilder.fromXDR(yield* signer.signTransaction(transaction), Networks.TESTNET)
      expect(hashes).toStrictEqual([`0x${unsigned().hash().toString("hex")}`])
      expect(signed.signatures.map((signature) => signature.hint())).toStrictEqual([keypair.signatureHint()])

      // a fee bump has its own hash
      const inner = unsigned()
      inner.sign(keypair)
      const bump = TransactionBuilder.buildFeeBumpTransaction(ADDRESS, "200", inner, Networks.TESTNET)
      const bumped = TransactionBuilder.fromXDR(
        yield* signer.signTransaction({ ...transaction, envelope: bump.toEnvelope().toXDR("base64") }),
        Networks.TESTNET
      )
      expect(hashes[1]).toBe(`0x${bump.hash().toString("hex")}`)
      expect(bumped.signatures).toHaveLength(1)
    }))

  it.effect("fromHashSigner fails on a failing signer, a foreign signature and a broken envelope", () =>
    Effect.gen(function*() {
      const failing = StellarSigner.fromHashSigner({ address: ADDRESS, signHash: () => Effect.fail("policy refused") })
      expect(yield* Effect.flip(failing.signTransaction(transaction))).toMatchObject({
        _tag: "StellarSignerError",
        cause: "policy refused"
      })
      const foreign = StellarSigner.fromHashSigner({
        address: ADDRESS,
        signHash: (hash) => Effect.succeed(new Uint8Array(OTHER.sign(Buffer.from(hash.slice(2), "hex"))))
      })
      expect((yield* Effect.flip(foreign.signTransaction(transaction)))._tag).toBe("StellarSignerError")
      expect((yield* Effect.flip(foreign.signTransaction({ ...transaction, envelope: "not XDR" })))._tag).toBe(
        "StellarSignerError"
      )
    }))
})
