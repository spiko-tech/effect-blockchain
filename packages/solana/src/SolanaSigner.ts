/**
 * Signers of Solana transactions: a local private key, or a custody API that signs raw bytes.
 *
 * A signer is a value and receives the whole serialized transaction message. Solana signs these bytes themselves,
 * without hashing them first, so what is being authorised can always be decoded from them. A transaction carries one
 * signature per signer account of its message, the fee payer's first.
 *
 * @since 0.2.0
 */
import {
  address,
  assertIsSignatureBytes,
  createKeyPairFromBytes,
  getAddressFromPublicKey,
  getBase58Encoder,
  getPublicKeyFromAddress,
  signBytes,
  verifySignature
} from "@solana/kit"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { SolanaAddress } from "./SolanaAddress.ts"

/**
 * A signature could not be produced: `cause` is the signer's own failure, or why its signature was refused. It never
 * holds a private key.
 *
 * @since 0.2.0
 * @category errors
 */
export class SolanaSignerError extends Schema.TaggedError<SolanaSignerError>()("SolanaSignerError", {
  cause: Schema.Defect()
}) {}

/**
 * Signs transactions as `address`. `signTransactionMessage` receives the serialized transaction message and returns
 * the 64-byte ed25519 signature of these bytes: Solana signs the message itself, where other chains sign its hash.
 *
 * @since 0.2.0
 * @category models
 */
export interface SolanaSigner {
  readonly address: SolanaAddress
  readonly signTransactionMessage: (message: Uint8Array) => Effect.Effect<Uint8Array, SolanaSignerError>
}

const toError = (cause: unknown) => new SolanaSignerError({ cause })

/**
 * A signer holding an ed25519 key in memory: `key` is the 64-byte secret key (the private key followed by its public
 * key) in base58, as wallets export it. An invalid key fails with a {@link SolanaSignerError} that does not repeat it.
 *
 * @since 0.2.0
 * @category constructors
 */
export const fromPrivateKey = (options: {
  readonly key: Redacted.Redacted<string>
}): Effect.Effect<SolanaSigner, SolanaSignerError> =>
  Effect.tryPromise({
    try: async () => {
      const keyPair = await createKeyPairFromBytes(getBase58Encoder().encode(Redacted.value(options.key)))
      return { keyPair, address: SolanaAddress.make(await getAddressFromPublicKey(keyPair.publicKey)) }
    },
    // the thrown error can quote the key
    catch: () => new SolanaSignerError({ cause: new Error("invalid private key") })
  }).pipe(Effect.map(({ address, keyPair }) => ({
    address,
    signTransactionMessage: (message) =>
      Effect.tryPromise({ try: () => signBytes(keyPair.privateKey, message), catch: toError })
  })))

/**
 * A signer for a key held elsewhere (a custody API, an HSM) that signs raw bytes. `signMessage` receives the
 * serialized transaction message and returns its 64-byte ed25519 signature. A failure of `signMessage`, a malformed
 * signature or one that `address` did not make fails with a {@link SolanaSignerError}.
 *
 * @since 0.2.0
 * @category constructors
 */
export const fromMessageSigner = <E>(options: {
  readonly address: SolanaAddress
  readonly signMessage: (message: Uint8Array) => Effect.Effect<Uint8Array, E>
}): SolanaSigner => ({
  address: options.address,
  signTransactionMessage: Effect.fnUntraced(function*(message) {
    const signature = yield* Effect.mapError(options.signMessage(message), toError)
    return yield* Effect.tryPromise({
      try: async () => {
        assertIsSignatureBytes(signature)
        const publicKey = await getPublicKeyFromAddress(address(options.address))
        if (!(await verifySignature(publicKey, signature, message))) {
          throw new Error(`not a signature of ${options.address}`)
        }
        return signature
      },
      catch: toError
    })
  })
})
