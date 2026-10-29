/**
 * Raw EVM hex data such as calldata, return data or event payloads.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"
import { isHex } from "viem"

const evmHexDataRegex = /^0x(?:[a-f0-9]{2})*$/

/**
 * An even-length 0x-prefixed hex string (`0x` alone is the empty payload), stored lowercase.
 *
 * @since 0.1.0
 * @category schemas
 */
export const EvmHexData = Schema.String.pipe(
  Schema.decodeTo(Schema.String.check(Schema.isLowercased()), SchemaTransformation.toLowerCase()),
  Schema.refine(
    (value: string): value is `0x${string}` => isHex(value, { strict: true }) && value.length % 2 === 0,
    {
      expected: "an even-length 0x-prefixed hex string",
      arbitraryConstraint: { patterns: [{ source: evmHexDataRegex.source, flags: "" }] }
    }
  ),
  Schema.brand("EvmHexData"),
  Schema.annotate({
    identifier: "EvmHexData",
    title: "EVM hex data",
    description: "an even-length 0x-prefixed hex string e.g. \"0xa9059cbb\""
  })
)

/**
 * @since 0.1.0
 * @category models
 */
export type EvmHexData = typeof EvmHexData.Type
