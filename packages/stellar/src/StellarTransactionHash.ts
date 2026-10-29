/**
 * Stellar transaction hashes.
 *
 * @since 0.1.0
 */
import { identity, pipe } from "effect/Function"
import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"

const stellarTransactionHashRegex = /^0x[a-f0-9]{64}$/u

/**
 * A Stellar transaction hash: 32 bytes as lowercase hex.
 *
 * Decoding lower-cases the input and adds a `0x` prefix when missing, so the raw 64-hex form Horizon and RPC return
 * is accepted and normalized to `0x…`. Encoding keeps the `0x` prefix: strip it before querying Stellar APIs.
 *
 * @since 0.1.0
 * @category schemas
 */
export const StellarTransactionHash = pipe(
  Schema.String,
  Schema.decodeTo(Schema.String.check(Schema.isLowercased()), SchemaTransformation.toLowerCase()),
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transform({ decode: (s: string) => (s.startsWith("0x") ? s : `0x${s}`), encode: identity })
  ),
  Schema.check(Schema.isPattern(stellarTransactionHashRegex, { message: "Not a valid Stellar transaction hash" })),
  Schema.brand("StellarTransactionHash"),
  Schema.annotate({
    identifier: "StellarTransactionHash",
    title: "StellarTransactionHash",
    description: "a valid Stellar transaction hash, 0x followed by 64 lowercase hexadecimal characters"
  })
)

/**
 * @since 0.1.0
 * @category models
 */
export type StellarTransactionHash = typeof StellarTransactionHash.Type
