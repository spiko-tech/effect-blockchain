/**
 * EVM transaction hashes.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"
import { isHash } from "viem"

const evmTransactionHashRegex = /^0x[a-f0-9]{64}$/

/**
 * An EVM transaction hash (0x followed by 64 hexadecimal characters), stored lowercase.
 *
 * @since 0.1.0
 * @category schemas
 */
export const EvmTransactionHash = Schema.String.pipe(
  Schema.decodeTo(Schema.String.check(Schema.isLowercased()), SchemaTransformation.toLowerCase()),
  Schema.refine((hash: string): hash is `0x${string}` => isHash(hash), {
    expected: "a valid EVM transaction hash",
    arbitraryConstraint: { patterns: [{ source: evmTransactionHashRegex.source, flags: "" }] }
  }),
  Schema.brand("EvmTransactionHash"),
  Schema.annotate({
    identifier: "EvmTransactionHash",
    title: "EVM transaction hash",
    description: "a valid EVM transaction hash, starting with 0x and followed by 64 hexadecimal characters"
  })
)

/**
 * @since 0.1.0
 * @category models
 */
export type EvmTransactionHash = typeof EvmTransactionHash.Type
