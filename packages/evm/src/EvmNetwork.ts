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
 * `Anvil` is the local Foundry node with its default chain ID 31337: a node started with another `--chain-id` must use
 * the network matching that ID, since the network check compares chain IDs.
 *
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
  "LineaSepolia",
  "Anvil"
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
  LineaSepolia: 59141,
  Anvil: 31337
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

// testnets reuse their mainnet value: same consensus and block time
const confirmations: Record<EvmNetwork, number> = {
  // finalized after 2 epochs of 32 slots: https://ethereum.org/en/developers/docs/consensus-mechanisms/pos/#finality
  Ethereum: 64,
  Sepolia: 64,
  // milestones finalize a block within 2 to 5 s, 1 to 3 blocks of 2 s. 32 blocks keep a margin for a late milestone,
  // when a block only has probabilistic finality: https://docs.polygon.technology/pos/concepts/finality/finality/
  Polygon: 32,
  PolygonAmoy: 32,
  // ~1 min of 2s blocks against sequencer reorgs: https://docs.optimism.io/stack/transactions/transaction-finality
  Base: 30,
  BaseSepolia: 30,
  // ~1 min of 0.25s blocks: https://docs.arbitrum.io/how-arbitrum-works/reference/finality-and-reorgs
  Arbitrum: 240,
  ArbitrumSepolia: 240,
  // confirmed on Tezos L1 in ~6s: https://docs.etherlink.com
  Etherlink: 20,
  EtherlinkTestnet: 20,
  // OP Stack, as Base: https://docs.optimism.io/stack/transactions/transaction-finality
  Optimism: 30,
  OptimismSepolia: 30,
  // Snowman acceptance is final: https://build.avax.network/docs/primary-network/avalanche-consensus
  Avalanche: 1,
  AvalancheFuji: 1,
  // fast finality finalizes a block once its child is justified. 50 blocks keep a margin for when no block is
  // justified and finality is probabilistic again: https://github.com/bnb-chain/BEPs/blob/master/BEPs/BEP126.md
  BnbSmartChain: 50,
  BnbSmartChainTestnet: 50,
  // 2 epochs of 16 slots: https://docs.gnosischain.com/about/specs/consensus/
  Gnosis: 32,
  // ~1 min of 2s blocks against sequencer reorgs: https://docs.linea.build/protocol/transaction-lifecycle
  Linea: 30,
  LineaSepolia: 30,
  // local node mines instantly and never reorgs: https://getfoundry.sh/anvil/overview
  Anvil: 0
}

/**
 * The number of blocks behind the head after which a block is treated as final by default.
 *
 * @since 0.1.0
 * @category getters
 */
export const defaultConfirmations = (network: EvmNetwork): number => confirmations[network]
