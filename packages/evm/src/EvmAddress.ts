/**
 * EVM account and contract addresses.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"
import { getAddress, isAddress } from "viem"

const evmAddressRegex = /^0x[a-f0-9]{40}$/

/**
 * An EVM address, decoded from any casing (including EIP-55 checksummed) and stored lowercase.
 *
 * @since 0.1.0
 * @category schemas
 */
export const EvmAddress = Schema.String.pipe(
  Schema.decodeTo(Schema.String.check(Schema.isLowercased()), SchemaTransformation.toLowerCase()),
  Schema.refine((address: string): address is `0x${string}` => isAddress(address), {
    expected: "a valid EVM address",
    arbitraryConstraint: { patterns: [{ source: evmAddressRegex.source, flags: "" }] }
  }),
  Schema.brand("EvmAddress"),
  Schema.annotate({
    identifier: "EvmAddress",
    title: "EVM address",
    description:
      "a valid EVM address, starting with 0x and followed by 40 hexadecimal characters e.g. \"0xb794f5ea0ba39494ce839613fffba74279579268\""
  })
)

/**
 * @since 0.1.0
 * @category models
 */
export type EvmAddress = typeof EvmAddress.Type

/**
 * The zero address `0x0000000000000000000000000000000000000000`, used as the mint source and burn target of tokens.
 *
 * @since 0.1.0
 * @category constants
 */
export const NULL_ADDRESS: EvmAddress = EvmAddress.make("0x0000000000000000000000000000000000000000")

/**
 * Returns the EIP-55 mixed-case checksum form of an address, e.g. for display.
 *
 * @since 0.1.0
 * @category conversions
 */
export const toEip55 = (address: EvmAddress): string => getAddress(address)
