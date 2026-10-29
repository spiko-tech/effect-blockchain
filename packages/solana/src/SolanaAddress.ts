/**
 * @since 0.1.0
 */
import { isAddress } from "@solana/kit"
import * as Schema from "effect/Schema"

const solanaAddressOf32BytesPattern = "^[2-9A-H][1-9A-HJ-NP-Za-km-z]{43}$"

/**
 * A base58-encoded Solana address (32 bytes), validated with `@solana/kit`.
 *
 * @since 0.1.0
 * @category Schemas
 */
export const SolanaAddress = Schema.String.annotate({
  title: "Solana address",
  description: "a valid Solana address, consisting of 32 to 44 base58 characters"
}).pipe(
  Schema.check(
    Schema.makeFilter((a: string) => isAddress(a) || `${a} is not a valid Solana address`, {
      arbitraryConstraint: { patterns: [{ source: solanaAddressOf32BytesPattern, flags: "" }] }
    })
  ),
  Schema.brand("SolanaAddress"),
  Schema.annotate({ identifier: "SolanaAddress" })
)

/**
 * @since 0.1.0
 * @category Models
 */
export type SolanaAddress = typeof SolanaAddress.Type

/**
 * The Solana System Program address.
 *
 * @since 0.1.0
 * @category Constants
 */
export const SYSTEM_PROGRAM_ADDRESS: SolanaAddress = SolanaAddress.make("11111111111111111111111111111111")
