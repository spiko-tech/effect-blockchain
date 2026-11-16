import * as BigInt_ from "effect/BigInt"
import * as StellarNetwork from "../StellarNetwork.ts"

/**
 * `latestLedger` minus `confirmations` (the network's default when unset), never below 0.
 *
 * @internal
 */
export const lastConfirmedBlock = (
  network: StellarNetwork.StellarNetwork,
  confirmations: number | undefined,
  latestLedger: bigint
): bigint =>
  BigInt_.max(latestLedger - BigInt(confirmations ?? StellarNetwork.defaultConfirmations(network)), BigInt(0))
