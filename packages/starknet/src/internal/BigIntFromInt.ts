import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"

/**
 * A JSON-RPC integer (`1234`) decoded to a `bigint`, e.g. a block number. Encoding fails beyond the safe integers.
 *
 * @internal
 */
export const BigIntFromInt = Schema.Int.pipe(
  Schema.decodeTo(Schema.BigInt, SchemaTransformation.transform({ decode: BigInt, encode: Number }))
)
