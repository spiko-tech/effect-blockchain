/**
 * Signers of Starknet transactions: a local private key, or a custody API that only signs a hash.
 *
 * A signer is a value and receives the whole transaction, never a hash chosen by its caller: signing an opaque hash
 * hides what is being authorised, and custody policy engines and hardware wallets refuse it. Only V3 `INVOKE` and
 * `DEPLOY_ACCOUNT` transactions are signed.
 *
 * A Starknet signature is whatever the account contract at `address` validates, so a signer returns felts and the
 * address is given, not derived from the key: `[r, s]` on the Stark curve for OpenZeppelin and Argent accounts.
 *
 * @since 0.2.0
 */
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { ec, num } from "starknet"
import { transactionHash } from "./internal/transactionHash.ts"
import type { StarknetAddress } from "./StarknetAddress.ts"
import type { StarknetDeployAccountTransaction, StarknetInvokeTransaction } from "./StarknetTransaction.ts"
import type { StarknetTransactionHash } from "./StarknetTransactionHash.ts"

/**
 * A signature could not be produced: `cause` is the signer's own failure, or why its signature was refused. It never
 * holds a private key.
 *
 * @since 0.2.0
 * @category errors
 */
export class StarknetSignerError extends Schema.TaggedError<StarknetSignerError>()("StarknetSignerError", {
  cause: Schema.Defect()
}) {}

/**
 * A V3 transaction before its signature.
 *
 * @since 0.2.0
 * @category models
 */
export type StarknetUnsignedTransaction =
  | Omit<StarknetInvokeTransaction, "signature">
  | Omit<StarknetDeployAccountTransaction, "signature">

/**
 * Signs transactions sent from the account contract at `address`. `signTransaction` returns the signature felts, in
 * the format that account contract validates.
 *
 * @since 0.2.0
 * @category models
 */
export interface StarknetSigner {
  readonly address: StarknetAddress
  readonly signTransaction: (
    transaction: StarknetUnsignedTransaction
  ) => Effect.Effect<ReadonlyArray<string>, StarknetSignerError>
}

const toError = (cause: unknown) => cause instanceof StarknetSignerError ? cause : new StarknetSignerError({ cause })

const isFelts = Schema.is(Schema.Array(Schema.String.check(Schema.isPattern(/^0x[0-9a-fA-F]{1,64}$/))))

/**
 * A signer for a key held elsewhere (a custody API, an HSM) that only signs a hash. `signHash` receives the V3
 * transaction hash and returns the signature felts of the account at `address`, `[r, s]` for OpenZeppelin and Argent
 * accounts. A failure of `signHash` or a signature that is not 0x-prefixed felts fails with a
 * {@link StarknetSignerError}; the signature itself is only checked by the account contract.
 *
 * @since 0.2.0
 * @category constructors
 */
export const fromHashSigner = <E>(options: {
  readonly address: StarknetAddress
  readonly signHash: (hash: StarknetTransactionHash) => Effect.Effect<ReadonlyArray<string>, E>
}): StarknetSigner => ({
  address: options.address,
  signTransaction: Effect.fnUntraced(function*(transaction) {
    const hash = yield* Effect.try({ try: () => transactionHash(transaction), catch: toError })
    const signature = yield* Effect.mapError(options.signHash(hash), toError)
    if (!isFelts(signature)) return yield* toError(new Error("the signature is not an array of 0x-prefixed felts"))
    return signature
  })
})

/**
 * A signer holding the Stark curve private key (hex) of the account at `address` in memory, signing
 * `[r, s]` as OpenZeppelin and Argent accounts validate. An invalid key fails with a {@link StarknetSignerError} that
 * does not repeat it.
 *
 * @since 0.2.0
 * @category constructors
 */
export const fromPrivateKey = (options: {
  readonly address: StarknetAddress
  readonly key: Redacted.Redacted<string>
}): Effect.Effect<StarknetSigner, StarknetSignerError> =>
  Effect.try({
    try: () => {
      const key = Redacted.value(options.key)
      ec.starkCurve.getStarkKey(key)
      return key
    },
    // the thrown error can quote the key
    catch: () => new StarknetSignerError({ cause: new Error("invalid private key") })
  }).pipe(Effect.map((key) =>
    fromHashSigner({
      address: options.address,
      signHash: (hash) =>
        Effect.try({
          try: () => {
            const { r, s } = ec.starkCurve.sign(hash, key)
            return [num.toHex(r), num.toHex(s)]
          },
          catch: toError
        })
    })
  ))
