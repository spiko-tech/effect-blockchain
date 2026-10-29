/**
 * @since 0.1.0
 */
import { isSignature } from "@solana/kit"
import * as Schema from "effect/Schema"

const solanaTransactionHashPattern = "^[1-9A-HJ-NP-Za-km-z]{87}$"

// `isSignature` from @solana/kit throws on non-base58 characters instead of returning false.
const isSolanaSignature = (value: string): boolean => {
  try {
    return isSignature(value)
  } catch {
    return false
  }
}

/**
 * A Solana transaction hash: a base58-encoded Ed25519 signature, validated with `@solana/kit`.
 *
 * @since 0.1.0
 * @category Schemas
 */
export const SolanaTransactionHash = Schema.String.annotate({
  title: "Solana transaction hash",
  description: "a valid Solana transaction hash (base58-encoded Ed25519 signature)"
}).pipe(
  Schema.check(
    Schema.makeFilter((s: string) => isSolanaSignature(s) || `${s} is not a valid Solana transaction hash`, {
      arbitraryConstraint: { patterns: [{ source: solanaTransactionHashPattern, flags: "" }] }
    })
  ),
  Schema.brand("SolanaTransactionHash"),
  Schema.annotate({ identifier: "SolanaTransactionHash" })
)

/**
 * @since 0.1.0
 * @category Models
 */
export type SolanaTransactionHash = typeof SolanaTransactionHash.Type
