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

/**
 * Default number of confirmations an indexer waits for on each network, on top
 * of the latest accepted block.
 *
 * @since 0.1.0
 * @category constants
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
