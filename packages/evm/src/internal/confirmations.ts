import * as BigInt_ from "effect/BigInt"
import * as Effect from "effect/Effect"
import * as EvmNetwork from "../EvmNetwork.ts"
import type * as EvmRpc from "../EvmRpc.ts"

/**
 * The head block number minus `confirmations` (the network's default when unset), never below 0.
 *
 * @internal
 */
export const lastConfirmedBlock = (
  rpc: EvmRpc.EvmRpc["Service"],
  confirmations: number | undefined
): Effect.Effect<bigint, EvmRpc.EvmRpcError> => {
  const depth = BigInt(confirmations ?? EvmNetwork.defaultConfirmations(rpc.network))
  return Effect.map(rpc.blockNumber, (head) => BigInt_.max(head - depth, BigInt(0)))
}
