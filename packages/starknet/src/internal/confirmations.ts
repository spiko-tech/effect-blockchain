import * as BigInt_ from "effect/BigInt"
import * as Effect from "effect/Effect"
import * as StarknetNetwork from "../StarknetNetwork.ts"
import type * as StarknetRpc from "../StarknetRpc.ts"

/**
 * The head block number minus `confirmations` (the network's default when unset), never below 0.
 *
 * @internal
 */
export const lastConfirmedBlock = (
  rpc: StarknetRpc.StarknetRpc["Service"],
  confirmations: number | undefined
): Effect.Effect<bigint, StarknetRpc.StarknetRpcError> => {
  const depth = BigInt(confirmations ?? StarknetNetwork.defaultConfirmations(rpc.network))
  return Effect.map(rpc.blockNumber, (head) => BigInt_.max(head - depth, BigInt(0)))
}
