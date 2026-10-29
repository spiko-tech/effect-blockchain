/**
 * Starknet contract and account addresses.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"
import { PaddedFelt } from "./internal/felt.ts"

/**
 * A Starknet address: `0x` followed by 64 lowercase hex digits.
 *
 * Decoding lowercases the input and left-pads it with zeros, so `"0x32"` decodes
 * to `"0x00…0032"`.
 *
 * @since 0.1.0
 * @category schemas
 */
export const StarknetAddress = PaddedFelt.pipe(
  Schema.brand("StarknetAddress"),
  Schema.annotate({
    identifier: "StarknetAddress",
    title: "StarknetAddress",
    description:
      "a valid Starknet address, starting with 0x and followed by 64 hexadecimal characters e.g. \"0x0000000000000000000000000000000000000000000000000000000000000000\""
  })
)

/**
 * @since 0.1.0
 * @category models
 */
export type StarknetAddress = typeof StarknetAddress.Type

/**
 * The Starknet zero address.
 *
 * @since 0.1.0
 * @category constants
 */
export const NullStarknetAddress: StarknetAddress = StarknetAddress.make(
  "0x0000000000000000000000000000000000000000000000000000000000000000"
)
