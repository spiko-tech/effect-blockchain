import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"

/**
 * A ledger sequence, a JSON number on the wire, decoded to a `bigint` like EVM block numbers.
 *
 * @internal
 */
export const LedgerFromNumber = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
  Schema.decodeTo(Schema.BigInt, SchemaTransformation.transform({ decode: BigInt, encode: Number }))
)
