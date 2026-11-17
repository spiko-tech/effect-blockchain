/**
 * Signers of EIP-1559 transactions: a private key held in memory, or a custody API that only signs a hash. The
 * reason a signer receives the whole transaction is described in
 * [Concepts](https://github.com/spiko-tech/effect-blockchain/blob/main/docs/concepts.md#signers).
 *
 * @since 0.3.0
 */
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { isHex, keccak256, parseSignature, recoverTransactionAddress, serializeTransaction } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { EvmAddress } from "./EvmAddress.ts"
import { EvmHexData } from "./EvmHexData.ts"
import type { EvmChainId } from "./EvmNetwork.ts"

/**
 * A signature could not be produced: `cause` is the signer's own failure, or why its signature was refused. It never
 * holds a private key.
 *
 * @since 0.3.0
 * @category errors
 */
export class EvmSignerError extends Schema.TaggedError<EvmSignerError>()("EvmSignerError", {
  cause: Schema.Defect()
}) {}

/**
 * An EIP-1559 transaction before its signature. `value` (default 0), `maxFeePerGas` and `maxPriorityFeePerGas` are in
 * wei, `data` defaults to `0x`.
 *
 * @since 0.3.0
 * @category models
 */
export interface EvmUnsignedTransaction {
  readonly chainId: EvmChainId
  readonly nonce: bigint
  readonly to: EvmAddress
  readonly value?: bigint | undefined
  readonly data?: EvmHexData | undefined
  readonly gas: bigint
  readonly maxFeePerGas: bigint
  readonly maxPriorityFeePerGas: bigint
}

/**
 * Signs transactions sent from `address`. `signTransaction` returns the signed transaction, serialized as
 * `eth_sendRawTransaction` takes it.
 *
 * @since 0.3.0
 * @category models
 */
export interface EvmSigner {
  readonly address: EvmAddress
  readonly signTransaction: (transaction: EvmUnsignedTransaction) => Effect.Effect<EvmHexData, EvmSignerError>
}

const toError = (cause: unknown) => new EvmSignerError({ cause })

const serializable = (transaction: EvmUnsignedTransaction) => ({
  type: "eip1559" as const,
  chainId: transaction.chainId,
  nonce: Number(transaction.nonce),
  to: transaction.to,
  value: transaction.value ?? BigInt(0),
  data: transaction.data ?? ("0x" as const),
  gas: transaction.gas,
  maxFeePerGas: transaction.maxFeePerGas,
  maxPriorityFeePerGas: transaction.maxPriorityFeePerGas
})

/**
 * A signer holding a secp256k1 private key (32 bytes, 0x-prefixed hex) in memory. An invalid key fails with an
 * {@link EvmSignerError} that does not repeat it.
 *
 * @since 0.3.0
 * @category constructors
 */
export const fromPrivateKey = (options: {
  readonly key: Redacted.Redacted<string>
}): Effect.Effect<EvmSigner, EvmSignerError> =>
  Effect.try({
    try: () => {
      const value = Redacted.value(options.key)
      if (!isHex(value)) throw new Error("not hex")
      return privateKeyToAccount(value)
    },
    // the thrown error can quote the key
    catch: () => new EvmSignerError({ cause: new Error("invalid private key") })
  }).pipe(Effect.map((account) => ({
    address: Schema.decodeSync(EvmAddress)(account.address),
    signTransaction: (transaction) =>
      Effect.tryPromise({ try: () => account.signTransaction(serializable(transaction)), catch: toError }).pipe(
        Effect.map((signed) => EvmHexData.make(signed))
      )
  })))

/**
 * A signer for a key held elsewhere (a custody API, an HSM) that only signs a 32-byte hash. `signHash` receives the
 * keccak256 of the unsigned EIP-1559 serialization and returns the 65-byte signature `r || s || v`, `v` being 0, 1, 27
 * or 28. A failure of `signHash`, a malformed signature or one that does not recover to `address` fails with an
 * {@link EvmSignerError}.
 *
 * @since 0.3.0
 * @category constructors
 */
export const fromHashSigner = <E>(options: {
  readonly address: EvmAddress
  readonly signHash: (hash: EvmHexData) => Effect.Effect<EvmHexData, E>
}): EvmSigner => ({
  address: options.address,
  signTransaction: Effect.fnUntraced(function*(transaction) {
    const unsigned = serializable(transaction)
    const hash = yield* Effect.try({ try: () => keccak256(serializeTransaction(unsigned)), catch: toError })
    const signature = yield* Effect.mapError(options.signHash(EvmHexData.make(hash)), toError)
    return yield* Effect.tryPromise({
      try: async () => {
        const signed = serializeTransaction(unsigned, parseSignature(signature))
        const signer = await recoverTransactionAddress({ serializedTransaction: signed })
        if (signer.toLowerCase() !== options.address) {
          throw new Error(`signed by ${signer}, expected ${options.address}`)
        }
        return EvmHexData.make(signed)
      },
      catch: toError
    })
  })
})
