import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"

const HexQuantity = Schema.String.check(Schema.isPattern(/^0x[0-9a-fA-F]+$/))

const toHex = (value: bigint | number) => `0x${value.toString(16)}`

/**
 * A JSON-RPC hex quantity (`"0x10"`) decoded to a `bigint`, e.g. a block number.
 *
 * @internal
 */
export const QuantityFromHex = HexQuantity.pipe(
  Schema.decodeTo(Schema.BigInt, SchemaTransformation.transform({ decode: BigInt, encode: toHex }))
)

/**
 * A JSON-RPC hex quantity decoded to a safe integer `number`, e.g. a chain ID or a log index.
 *
 * @internal
 */
export const IntFromHex = HexQuantity.pipe(
  Schema.decodeTo(Schema.Int, SchemaTransformation.transform({ decode: Number, encode: toHex }))
)
