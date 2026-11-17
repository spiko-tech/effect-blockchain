import { SolanaAddress } from "@effect-blockchain/solana/SolanaAddress"
import * as SolanaSigner from "@effect-blockchain/solana/SolanaSigner"
import { describe, expect, it } from "@effect/vitest"
import {
  AccountRole,
  address,
  appendTransactionMessageInstruction,
  blockhash,
  compileTransaction,
  createKeyPairFromPrivateKeyBytes,
  createTransactionMessage,
  getAddressFromPublicKey,
  getBase58Decoder,
  getBase58Encoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransaction
} from "@solana/kit"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"

const TO = address("6rS8E5CQHLHmLenNNevUdJ9APzKNairr1kfWAM3EhDX3")

// a key pair made from `seed`, with its 64-byte secret key in base58
const keyOf = async (seed: number) => {
  const privateKey = new Uint8Array(32).fill(seed)
  const keyPair = await createKeyPairFromPrivateKeyBytes(privateKey)
  const owner = await getAddressFromPublicKey(keyPair.publicKey)
  const secret = getBase58Decoder().decode(Uint8Array.from([...privateKey, ...getBase58Encoder().encode(owner)]))
  return { keyPair, owner, secret }
}

// a v0 transfer of 1 lamport paid by `owner`, signed by `@solana/kit`
const transferOf = async ({ keyPair, owner }: Awaited<ReturnType<typeof keyOf>>) => {
  const compiled = compileTransaction(pipe(
    createTransactionMessage({ version: 0 }),
    (message) => setTransactionMessageFeePayer(owner, message),
    (message) =>
      setTransactionMessageLifetimeUsingBlockhash({
        blockhash: blockhash("fg5jAcb27Hok8kTbs8bzgACf8SyfWF51NGoPabTJAPm"),
        lastValidBlockHeight: BigInt(448190049)
      }, message),
    (message) =>
      appendTransactionMessageInstruction({
        programAddress: address("11111111111111111111111111111111"),
        accounts: [{ address: owner, role: AccountRole.WRITABLE_SIGNER }, { address: TO, role: AccountRole.WRITABLE }],
        data: Uint8Array.from([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0])
      }, message)
  ))
  const signed = await signTransaction([keyPair], compiled)
  return { message: Uint8Array.from(compiled.messageBytes), signature: Uint8Array.from(signed.signatures[owner] ?? []) }
}

const setup = Effect.promise(async () => {
  const key = await keyOf(1)
  return { ...key, ...(await transferOf(key)), other: await transferOf(await keyOf(2)) }
})

describe("SolanaSigner", () => {
  it.effect("fromPrivateKey signs a transaction message as @solana/kit does", () =>
    Effect.gen(function*() {
      const { message, owner, secret, signature } = yield* setup
      const signer = yield* SolanaSigner.fromPrivateKey({ key: Redacted.make(secret) })
      expect(signer.address).toBe(owner)
      expect(signature).toHaveLength(64)
      expect(yield* signer.signTransactionMessage(message)).toStrictEqual(signature)
    }))

  it.effect("fromPrivateKey fails on an invalid key without repeating it", () =>
    Effect.gen(function*() {
      const { other, secret } = yield* setup
      const mismatched = secret.slice(0, -4) + getBase58Decoder().decode(other.signature).slice(0, 4)
      for (const key of ["not base58 0OIl", secret.slice(0, 40), mismatched]) {
        const error = yield* Effect.flip(SolanaSigner.fromPrivateKey({ key: Redacted.make(key) }))
        expect(error._tag).toBe("SolanaSignerError")
        expect(error.cause).toStrictEqual(new Error("invalid private key"))
      }
    }))

  it.effect("fromMessageSigner hands the message to the custody signer and returns its signature", () =>
    Effect.gen(function*() {
      const { message, owner, signature } = yield* setup
      const signer = SolanaSigner.fromMessageSigner({
        address: SolanaAddress.make(owner),
        signMessage: (received) => {
          expect(received).toStrictEqual(message)
          return Effect.succeed(signature)
        }
      })
      expect(signer.address).toBe(owner)
      expect(yield* signer.signTransactionMessage(message)).toStrictEqual(signature)
    }))

  it.effect("fromMessageSigner refuses a malformed signature, another key's and a custody failure", () =>
    Effect.gen(function*() {
      const { message, other, owner, signature } = yield* setup
      const sign = (signMessage: Effect.Effect<Uint8Array, string>) =>
        Effect.flip(
          SolanaSigner.fromMessageSigner({ address: SolanaAddress.make(owner), signMessage: () => signMessage })
            .signTransactionMessage(message)
        )
      const short = yield* sign(Effect.succeed(signature.slice(0, 63)))
      expect(short._tag).toBe("SolanaSignerError")
      const foreign = yield* sign(Effect.succeed(other.signature))
      expect(foreign.cause).toStrictEqual(new Error(`not a signature of ${owner}`))
      const down = yield* sign(Effect.fail("custody down"))
      expect(down).toMatchObject({ _tag: "SolanaSignerError", cause: "custody down" })
    }))
})
