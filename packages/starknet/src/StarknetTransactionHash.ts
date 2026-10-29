/**
 * Starknet transaction hashes.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"
import { PaddedFelt } from "./internal/felt.ts"

/**
 * A Starknet transaction hash: `0x` followed by 64 lowercase hex digits.
 *
 * Decoding lowercases the input and left-pads it with zeros, so `"0xc9"` decodes
 * to `"0x00…00c9"`.
 *
 * @since 0.1.0
 * @category schemas
 */
export const StarknetTransactionHash = PaddedFelt.pipe(
  Schema.brand("StarknetTransactionHash"),
  Schema.annotate({
    identifier: "StarknetTransactionHash",
    title: "StarknetTransactionHash",
    description: "a valid Starknet transaction hash, starting with 0x and followed by 64 hexadecimal characters"
  })
)

/**
 * @since 0.1.0
 * @category models
 */
export type StarknetTransactionHash = typeof StarknetTransactionHash.Type
