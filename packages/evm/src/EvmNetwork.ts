/**
 * Named EVM networks and their chain IDs.
 *
 * @since 0.1.0
 */
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

/**
 * @since 0.1.0
 * @category constants
 */
export const mainnets = [
  "Ethereum",
  "Polygon",
  "Base",
  "Arbitrum",
  "Etherlink",
  "Optimism",
  "Avalanche",
  "BnbSmartChain",
  "Gnosis",
  "Linea"
] as const

/**
 * @since 0.1.0
 * @category constants
 */
export const testnets = [
  "Sepolia",
  "PolygonAmoy",
  "BaseSepolia",
  "ArbitrumSepolia",
  "EtherlinkTestnet",
  "OptimismSepolia",
  "AvalancheFuji",
  "BnbSmartChainTestnet",
  "LineaSepolia"
] as const

/**
 * Every supported network, mainnets first.
 *
 * @since 0.1.0
 * @category constants
 */
export const networks = [...mainnets, ...testnets] as const

/**
 * @since 0.1.0
 * @category schemas
 */
export const EvmNetwork = Schema.Literals(networks).annotate({
  identifier: "EvmNetwork",
  title: "EVM network",
  description: "a named EVM network e.g. \"Ethereum\", \"Polygon\", \"Arbitrum\""
})

/**
 * @since 0.1.0
 * @category models
 */
export type EvmNetwork = typeof EvmNetwork.Type

/**
 * An EIP-155 chain ID: a positive integer.
 *
 * @since 0.1.0
 * @category schemas
 */
export const EvmChainId = Schema.Int.check(Schema.isGreaterThan(0)).pipe(
  Schema.brand("EvmChainId"),
  Schema.annotate({
    identifier: "EvmChainId",
    title: "EVM chain ID",
    description: "an EIP-155 chain ID, a positive integer e.g. 1 for Ethereum"
  })
)

/**
 * @since 0.1.0
 * @category models
 */
export type EvmChainId = typeof EvmChainId.Type

const chainIds: Record<EvmNetwork, number> = {
  Ethereum: 1,
  Sepolia: 11155111,
  Polygon: 137,
  PolygonAmoy: 80002,
  Base: 8453,
  BaseSepolia: 84532,
  Arbitrum: 42161,
  ArbitrumSepolia: 421614,
  Etherlink: 42793,
  EtherlinkTestnet: 128123,
  Optimism: 10,
  OptimismSepolia: 11155420,
  Avalanche: 43114,
  AvalancheFuji: 43113,
  BnbSmartChain: 56,
  BnbSmartChainTestnet: 97,
  Gnosis: 100,
  Linea: 59144,
  LineaSepolia: 59141
}

/**
 * @since 0.1.0
 * @category conversions
 */
export const toChainId = (network: EvmNetwork): EvmChainId => EvmChainId.make(chainIds[network])

/**
 * Returns the named network for a chain ID, or `None` when the chain is not in {@link networks}.
 *
 * @since 0.1.0
 * @category conversions
 */
export const fromChainId = (chainId: number): Option.Option<EvmNetwork> =>
  Option.fromNullishOr(networks.find((network) => chainIds[network] === chainId))

/**
 * @since 0.1.0
 * @category predicates
 */
export const isTestnet = (network: EvmNetwork): boolean => (testnets as ReadonlyArray<EvmNetwork>).includes(network)
