import { identity } from "effect/Function"
import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"

const padFelt = (hex: string): string => `0x${(hex.startsWith("0x") ? hex.slice(2) : hex).padStart(64, "0")}`

/**
 * A field element as a hex string: accepts 1 to 64 hex digits with an optional
 * `0x` prefix in any case, decodes to `0x` + 64 lowercase hex digits.
 *
 * @internal
 */
export const PaddedFelt = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^(0x)?[0-9a-fA-F]{1,64}$/u)),
  Schema.decodeTo(Schema.String, SchemaTransformation.toLowerCase()),
  Schema.decodeTo(Schema.String, SchemaTransformation.transform({ decode: padFelt, encode: identity })),
  Schema.check(Schema.isPattern(/^0x[0-9a-f]{64}$/u))
)
