/**
 * Stellar networks and their passphrases.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"

/**
 * @since 0.1.0
 * @category constants
 */
export const STELLAR_MAINNET_NETWORKS = ["Stellar"] as const

/**
 * @since 0.1.0
 * @category constants
 */
export const STELLAR_TESTNET_NETWORKS = ["StellarTestnet"] as const

/**
 * @since 0.1.0
 * @category constants
 */
export const STELLAR_NETWORKS = [...STELLAR_MAINNET_NETWORKS, ...STELLAR_TESTNET_NETWORKS] as const

/**
 * A named Stellar network: `Stellar` (public mainnet) or `StellarTestnet`.
 *
 * @since 0.1.0
 * @category schemas
 */
export const StellarNetwork = Schema.Literals(STELLAR_NETWORKS).annotate({
  identifier: "StellarNetwork",
  title: "StellarNetwork",
  description: "a Stellar network name"
})

/**
 * @since 0.1.0
 * @category models
 */
export type StellarNetwork = typeof StellarNetwork.Type

/**
 * Network passphrases, used to sign transactions (same values as `Networks.PUBLIC` / `Networks.TESTNET` in
 * `@stellar/stellar-sdk`).
 *
 * @since 0.1.0
 * @category constants
 */
export const STELLAR_NETWORK_PASSPHRASES: { readonly [N in StellarNetwork]: string } = {
  Stellar: "Public Global Stellar Network ; September 2015",
  StellarTestnet: "Test SDF Network ; September 2015"
}
