/**
 * Named Stellar networks and their passphrases.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"

/**
 * @since 0.1.0
 * @category constants
 */
export const mainnets = ["Stellar"] as const

/**
 * @since 0.1.0
 * @category constants
 */
export const testnets = ["StellarTestnet"] as const

/**
 * Every supported network, mainnets first.
 *
 * @since 0.1.0
 * @category constants
 */
export const networks = [...mainnets, ...testnets] as const

/**
 * A named Stellar network: `Stellar` (public mainnet) or `StellarTestnet`.
 *
 * @since 0.1.0
 * @category schemas
 */
export const StellarNetwork = Schema.Literals(networks).annotate({
  identifier: "StellarNetwork",
  title: "StellarNetwork",
  description: "a Stellar network name"
})

/**
 * @since 0.1.0
 * @category models
 */
export type StellarNetwork = typeof StellarNetwork.Type

// same values as `Networks.PUBLIC` / `Networks.TESTNET` in `@stellar/stellar-sdk`
const passphrases: Record<StellarNetwork, string> = {
  Stellar: "Public Global Stellar Network ; September 2015",
  StellarTestnet: "Test SDF Network ; September 2015"
}

/**
 * The network passphrase, used to sign transactions and reported by `getNetwork`.
 *
 * @since 0.1.0
 * @category conversions
 */
export const toPassphrase = (network: StellarNetwork): string => passphrases[network]

const confirmations: Record<StellarNetwork, number> = {
  // SCP gives deterministic finality, a closed ledger is never reverted:
  // https://developers.stellar.org/docs/learn/fundamentals/stellar-consensus-protocol
  Stellar: 0,
  // same consensus as mainnet (testnet resets wipe all history, they do not reorganise closed ledgers)
  StellarTestnet: 0
}

/**
 * Ledgers to wait behind the latest closed ledger before treating it as confirmed: `0`, Stellar has no forks and a
 * ledger is final once closed.
 *
 * @since 0.1.0
 * @category utils
 */
export const defaultConfirmations = (network: StellarNetwork): number => confirmations[network]

/**
 * @since 0.1.0
 * @category predicates
 */
export const isTestnet = (network: StellarNetwork): boolean =>
  (testnets as ReadonlyArray<StellarNetwork>).includes(network)
