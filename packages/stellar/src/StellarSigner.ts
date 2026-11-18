/**
 * Signers of Stellar transaction and fee bump envelopes: a secret seed held in memory, or a custody API that only
 * signs a hash. The signature is added to the ones the envelope already carries. The reason a signer receives the
 * whole envelope is described in
 * [Concepts](https://github.com/spiko-tech/effect-blockchain/blob/main/docs/concepts.md#signers).
 *
 * @since 0.2.0
 */
import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { StellarAccountAddress } from "./StellarAddress.ts"
import { type StellarNetwork, toPassphrase } from "./StellarNetwork.ts"
import { StellarTransactionHash } from "./StellarTransactionHash.ts"

/**
 * A signature could not be produced: `cause` is the signer's own failure, why its signature was refused, or why the
 * transaction could not be built. It never holds a secret seed.
 *
 * @since 0.2.0
 * @category errors
 */
export class StellarSignerError extends Schema.TaggedError<StellarSignerError>()("StellarSignerError", {
  cause: Schema.Defect()
}) {}

/**
 * A transaction to sign: its base64 `TransactionEnvelope` XDR, a transaction or a fee bump, and the network whose
 * passphrase the signature covers.
 *
 * @since 0.2.0
 * @category models
 */
export interface StellarUnsignedTransaction {
  readonly network: StellarNetwork
  readonly envelope: string
}

/**
 * Signs transactions for the account `address`. `signTransaction` returns the envelope with the signature added, as
 * base64 XDR, as `sendTransaction` takes it.
 *
 * @since 0.2.0
 * @category models
 */
export interface StellarSigner {
  readonly address: StellarAccountAddress
  readonly signTransaction: (transaction: StellarUnsignedTransaction) => Effect.Effect<string, StellarSignerError>
}

const toError = (cause: unknown) => new StellarSignerError({ cause })

/**
 * A signer for a key held elsewhere (a custody API, an HSM) that only signs a 32-byte hash. `signHash` receives the
 * transaction hash (the SHA-256 of the network id and the tagged transaction) and returns the 64-byte ed25519
 * signature. A failure of `signHash`, an envelope that is not XDR or a signature that `address` did not make fails
 * with a {@link StellarSignerError}.
 *
 * @since 0.2.0
 * @category constructors
 */
export const fromHashSigner = <E>(options: {
  readonly address: StellarAccountAddress
  readonly signHash: (hash: StellarTransactionHash) => Effect.Effect<Uint8Array, E>
}): StellarSigner => ({
  address: options.address,
  signTransaction: Effect.fnUntraced(function*({ envelope, network }) {
    const transaction = yield* Effect.try({
      try: () => TransactionBuilder.fromXdr(envelope, toPassphrase(network)),
      catch: toError
    })
    const hash = StellarTransactionHash.make(`0x${Buffer.from(transaction.hash()).toString("hex")}`)
    const signature = yield* Effect.mapError(options.signHash(hash), toError)
    return yield* Effect.try({
      try: () => {
        // verifies the signature against the hash and the address
        transaction.addSignature(options.address, Buffer.from(signature).toString("base64"))
        return transaction.toEnvelope().toXdr("base64")
      },
      catch: toError
    })
  })
})

/**
 * A signer holding an ed25519 secret seed (`S...`) in memory. An invalid seed fails with a
 * {@link StellarSignerError} that does not repeat it.
 *
 * @since 0.2.0
 * @category constructors
 */
export const fromPrivateKey = (options: {
  readonly key: Redacted.Redacted<string>
}): Effect.Effect<StellarSigner, StellarSignerError> =>
  Effect.try({
    try: () => Keypair.fromSecret(Redacted.value(options.key)),
    // the thrown error can quote the seed
    catch: () => new StellarSignerError({ cause: new Error("invalid secret seed") })
  }).pipe(Effect.map((keypair) =>
    fromHashSigner({
      address: StellarAccountAddress.make(keypair.publicKey()),
      signHash: (hash) => Effect.try(() => keypair.sign(Buffer.from(hash.slice(2), "hex")))
    })
  ))
