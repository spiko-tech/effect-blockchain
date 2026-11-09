/**
 * Named Starknet networks and their chain IDs.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"
import { StarknetAddress } from "./StarknetAddress.ts"

/**
 * @since 0.1.0
 * @category constants
 */
export const mainnets = ["Starknet"] as const

/**
 * @since 0.1.0
 * @category constants
 */
export const testnets = ["StarknetSepolia"] as const

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
export const StarknetNetwork = Schema.Literals(networks).annotate({
  identifier: "StarknetNetwork",
  title: "Starknet network",
  description: "a Starknet network name: \"Starknet\" (mainnet) or \"StarknetSepolia\" (testnet)"
})

/**
 * @since 0.1.0
 * @category models
 */
export type StarknetNetwork = typeof StarknetNetwork.Type

/**
 * A Starknet chain ID, the short string `starknet_chainId` returns.
 *
 * @since 0.1.0
 * @category schemas
 */
export const StarknetChainId = Schema.Literals(["SN_MAIN", "SN_SEPOLIA"]).annotate({
  identifier: "StarknetChainId",
  title: "Starknet chain ID",
  description: "a Starknet chain ID as a short string: \"SN_MAIN\" or \"SN_SEPOLIA\""
})

/**
 * @since 0.1.0
 * @category models
 */
export type StarknetChainId = typeof StarknetChainId.Type

const chainIds: Record<StarknetNetwork, StarknetChainId> = {
  Starknet: "SN_MAIN",
  StarknetSepolia: "SN_SEPOLIA"
}

/**
 * @since 0.1.0
 * @category conversions
 */
export const toChainId = (network: StarknetNetwork): StarknetChainId => chainIds[network]

/**
 * Default number of confirmations an indexer waits for on each network, on top of the latest accepted block.
 *
 * @since 0.1.0
 * @category getters
 */
export const defaultConfirmations = (network: StarknetNetwork): number => {
  switch (network) {
    // ACCEPTED_ON_L2 blocks are "finalized by the consensus protocol": https://docs.starknet.io/learn/protocol/transactions
    case "Starknet":
      return 0
    // same protocol and finality rules as mainnet: https://docs.starknet.io/learn/protocol/transactions
    case "StarknetSepolia":
      return 0
  }
}

/**
 * The STRK token contract, the token Starknet fees are paid in, counted in fri (10^-18 STRK). The same address on
 * mainnet and Sepolia: https://docs.starknet.io/resources/chain-info
 *
 * @since 0.2.0
 * @category constants
 */
export const STRK_TOKEN_ADDRESS: StarknetAddress = StarknetAddress.make(
  "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d"
)

/**
 * @since 0.1.0
 * @category predicates
 */
export const isTestnet = (network: StarknetNetwork): boolean =>
  (testnets as ReadonlyArray<StarknetNetwork>).includes(network)
