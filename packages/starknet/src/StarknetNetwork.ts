/**
 * Starknet networks.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"

/**
 * A named Starknet network.
 *
 * @since 0.1.0
 * @category schemas
 */
export const StarknetNetwork = Schema.Literals(["Starknet", "StarknetSepolia"]).annotate({
  identifier: "StarknetNetwork",
  title: "StarknetNetwork",
  description: "a Starknet network name: \"Starknet\" (mainnet) or \"StarknetSepolia\" (testnet)"
})

/**
 * @since 0.1.0
 * @category models
 */
export type StarknetNetwork = typeof StarknetNetwork.Type

/**
 * Static metadata of a Starknet network. `chainId` is the protocol chain
 * identifier as a short string.
 *
 * @since 0.1.0
 * @category models
 */
export interface StarknetNetworkInfo {
  readonly name: string
  readonly chainId: "SN_MAIN" | "SN_SEPOLIA"
  readonly type: "mainnet" | "testnet"
}

/**
 * Metadata of every Starknet network, keyed by network.
 *
 * @since 0.1.0
 * @category constants
 */
export const starknetNetworks: { readonly [N in StarknetNetwork]: StarknetNetworkInfo } = {
  Starknet: { name: "Starknet", chainId: "SN_MAIN", type: "mainnet" },
  StarknetSepolia: { name: "Starknet Sepolia", chainId: "SN_SEPOLIA", type: "testnet" }
}
