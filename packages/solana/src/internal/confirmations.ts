import * as BigInt_ from "effect/BigInt"
import * as Effect from "effect/Effect"
import * as SolanaNetwork from "../SolanaNetwork.ts"
import type { SolanaRpc, SolanaRpcError } from "../SolanaRpc.ts"

/**
 * The `finalized` slot minus `confirmations` (the network's default when unset), never below 0.
 *
 * @internal
 */
export const lastConfirmedBlock = (
  rpc: SolanaRpc["Service"],
  confirmations: number | undefined
): Effect.Effect<bigint, SolanaRpcError> => {
  const depth = BigInt(confirmations ?? SolanaNetwork.defaultConfirmations(rpc.network))
  return Effect.map(rpc.getSlot({ commitment: "finalized" }), (slot) => BigInt_.max(slot - depth, BigInt(0)))
}
