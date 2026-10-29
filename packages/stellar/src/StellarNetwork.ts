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

const DEFAULT_CONFIRMATIONS: { readonly [N in StellarNetwork]: number } = {
  // SCP gives deterministic finality, a closed ledger is never reverted:
  // https://developers.stellar.org/docs/learn/fundamentals/stellar-consensus-protocol
  Stellar: 0,
  // Same consensus as mainnet (testnet resets wipe all history, they do not reorganise closed ledgers)
  StellarTestnet: 0
}

/**
 * Default number of ledgers to wait behind the latest closed ledger before treating it as confirmed.
 *
 * Stellar has no forks: a ledger is final once closed by SCP, so the default is `0`.
 *
 * @since 0.1.0
 * @category constants
 */
export const defaultConfirmations = (network: StellarNetwork): number => DEFAULT_CONFIRMATIONS[network]
