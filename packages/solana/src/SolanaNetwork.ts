/**
 * Named Solana clusters and their genesis hashes.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"

/**
 * @since 0.1.0
 * @category constants
 */
export const mainnets = ["Solana"] as const

/**
 * @since 0.1.0
 * @category constants
 */
export const testnets = ["SolanaDevnet", "SolanaTestnet"] as const

/**
 * Every supported network, mainnets first.
 *
 * @since 0.1.0
 * @category constants
 */
export const networks = [...mainnets, ...testnets] as const

/**
 * A named Solana cluster.
 *
 * @since 0.1.0
 * @category schemas
 */
export const SolanaNetwork = Schema.Literals(networks).annotate({
  identifier: "SolanaNetwork",
  title: "Solana network",
  description: "a named Solana cluster: Solana (mainnet-beta), SolanaDevnet or SolanaTestnet"
})

/**
 * @since 0.1.0
 * @category models
 */
export type SolanaNetwork = typeof SolanaNetwork.Type

// `--expected-genesis-hash` of each cluster, https://docs.anza.xyz/clusters/available
const genesisHashes: Record<SolanaNetwork, string> = {
  Solana: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  SolanaDevnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  SolanaTestnet: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY"
}

/**
 * The cluster's genesis hash, reported by `getGenesisHash`.
 *
 * @since 0.1.0
 * @category conversions
 */
export const toGenesisHash = (network: SolanaNetwork): string => genesisHashes[network]

/**
 * @since 0.1.0
 * @category predicates
 */
export const isTestnet = (network: SolanaNetwork): boolean =>
  (testnets as ReadonlyArray<SolanaNetwork>).includes(network)
