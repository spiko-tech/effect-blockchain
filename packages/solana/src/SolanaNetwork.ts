/**
 * Named Solana clusters and their genesis hashes.
 *
 * @since 0.1.0
 */
import { isBlockhash } from "@solana/kit"
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

// like `SolanaAddress`: always 32 bytes once decoded
const solanaGenesisHashPattern = "^[2-9A-H][1-9A-HJ-NP-Za-km-z]{43}$"

/**
 * A Solana genesis hash: a base58-encoded 32-byte hash, validated with `@solana/kit`.
 *
 * @since 0.1.0
 * @category schemas
 */
export const SolanaGenesisHash = Schema.String.annotate({
  title: "Solana genesis hash",
  description: "a valid Solana genesis hash (base58-encoded 32-byte hash)"
}).pipe(
  Schema.check(
    Schema.makeFilter((s: string) => isBlockhash(s) || `${s} is not a valid Solana genesis hash`, {
      arbitraryConstraint: { patterns: [{ source: solanaGenesisHashPattern, flags: "" }] }
    })
  ),
  Schema.brand("SolanaGenesisHash"),
  Schema.annotate({ identifier: "SolanaGenesisHash" })
)

/**
 * @since 0.1.0
 * @category models
 */
export type SolanaGenesisHash = typeof SolanaGenesisHash.Type

// `--expected-genesis-hash` of each cluster, https://docs.anza.xyz/clusters/available
const genesisHashes: Record<SolanaNetwork, SolanaGenesisHash> = {
  Solana: SolanaGenesisHash.make("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"),
  SolanaDevnet: SolanaGenesisHash.make("EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"),
  SolanaTestnet: SolanaGenesisHash.make("4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY")
}

/**
 * The cluster's genesis hash, reported by `getGenesisHash`.
 *
 * @since 0.1.0
 * @category conversions
 */
export const toGenesisHash = (network: SolanaNetwork): SolanaGenesisHash => genesisHashes[network]

/**
 * @since 0.1.0
 * @category predicates
 */
export const isTestnet = (network: SolanaNetwork): boolean =>
  (testnets as ReadonlyArray<SolanaNetwork>).includes(network)

/**
 * Default number of slots `SolanaIndexer` stays behind the head: 0 on every network. The indexer reads at `finalized`
 * commitment, and a block is finalized once 31+ confirmed blocks are built on top of it
 * (https://docs.anza.xyz/consensus/commitments), so the finalized slot needs no further margin.
 *
 * @since 0.1.0
 * @category getters
 */
export const defaultConfirmations = (_network: SolanaNetwork): number => 0
