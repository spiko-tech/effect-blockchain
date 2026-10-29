/**
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"

/**
 * A named Solana cluster.
 *
 * @since 0.1.0
 * @category Schemas
 */
export const SolanaNetwork = Schema.Literals(["Solana", "SolanaDevnet", "SolanaTestnet"]).annotate({
  identifier: "SolanaNetwork",
  title: "Solana network",
  description: "a named Solana cluster: Solana (mainnet-beta), SolanaDevnet or SolanaTestnet"
})

/**
 * @since 0.1.0
 * @category Models
 */
export type SolanaNetwork = typeof SolanaNetwork.Type

/**
 * Whether a network carries real value (`mainnet`) or is used for testing (`testnet`).
 *
 * @since 0.1.0
 * @category Schemas
 */
export const SolanaNetworkKind = Schema.Literals(["mainnet", "testnet"]).annotate({
  identifier: "SolanaNetworkKind",
  title: "Solana network kind",
  description: "mainnet or testnet"
})

/**
 * @since 0.1.0
 * @category Models
 */
export type SolanaNetworkKind = typeof SolanaNetworkKind.Type

/**
 * The kind of each Solana network.
 *
 * @since 0.1.0
 * @category Constants
 */
export const SOLANA_NETWORK_KINDS: { readonly [N in SolanaNetwork]: SolanaNetworkKind } = {
  Solana: "mainnet",
  SolanaDevnet: "testnet",
  SolanaTestnet: "testnet"
}

/**
 * @since 0.1.0
 * @category Guards
 */
export const isSolanaNetwork: (u: unknown) => u is SolanaNetwork = Schema.is(SolanaNetwork)
