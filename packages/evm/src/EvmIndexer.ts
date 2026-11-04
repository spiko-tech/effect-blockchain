/**
 * A raw EVM log indexer on top of {@link EvmRpc.EvmRpc}: the last confirmed block and the logs of a set of contracts
 * over any block range.
 *
 * `fetchLogs` splits `[fromBlock, toBlock]` into consecutive chunks of at most `maxBlockRange` blocks and sends one
 * `eth_getLogs` per chunk, one after another. Each chunk comes back in chain order, so the concatenation is too.
 * The first failing chunk fails the whole call with its {@link EvmRpc.EvmRpcError}, after `EvmRpc`'s own retries and
 * fallback, and the logs of the chunks before it are dropped: the caller restarts from `fromBlock`.
 *
 * @since 0.1.0
 */
import * as BigInt_ from "effect/BigInt"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type { EvmLog } from "./EvmLog.ts"
import * as EvmNetwork from "./EvmNetwork.ts"
import * as EvmRpc from "./EvmRpc.ts"

/**
 * @since 0.1.0
 * @category services
 */
export class EvmIndexer extends Context.Service<EvmIndexer, {
  /** The head block number minus the confirmations, never below 0. */
  readonly lastConfirmedBlock: Effect.Effect<bigint, EvmRpc.EvmRpcError>
  /**
   * The logs matching `filter` between `fromBlock` and `toBlock` (both inclusive), in chain order: sorted by block
   * then log index. `fromBlock > toBlock` returns `[]`. A `toBlock` above {@link lastConfirmedBlock} is accepted.
   */
  readonly fetchLogs: (filter: EvmRpc.EvmLogsFilter) => Effect.Effect<ReadonlyArray<EvmLog>, EvmRpc.EvmRpcError>
}>()("@effect-blockchain/evm/EvmIndexer") {}

/**
 * The default `maxBlockRange`: most RPC providers accept `eth_getLogs` over 1000 blocks, lower it for stricter ones.
 *
 * @since 0.1.0
 * @category constants
 */
export const DEFAULT_MAX_BLOCK_RANGE = 1000

/**
 * Builds an {@link EvmIndexer} reading through the provided {@link EvmRpc.EvmRpc}.
 *
 * - `confirmations` overrides {@link EvmNetwork.defaultConfirmations} for the RPC's network.
 * - `maxBlockRange`, a positive integer, defaults to {@link DEFAULT_MAX_BLOCK_RANGE}.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer = (options: {
  readonly confirmations?: number | undefined
  readonly maxBlockRange?: number | undefined
} = {}): Layer.Layer<EvmIndexer, never, EvmRpc.EvmRpc> =>
  Layer.effect(
    EvmIndexer,
    Effect.gen(function*() {
      const rpc = yield* EvmRpc.EvmRpc
      const maxBlockRange = options.maxBlockRange ?? DEFAULT_MAX_BLOCK_RANGE
      if (!Number.isSafeInteger(maxBlockRange) || maxBlockRange < 1) {
        return yield* Effect.die(new RangeError(`maxBlockRange must be a positive integer, got ${maxBlockRange}`))
      }
      const confirmations = BigInt(options.confirmations ?? EvmNetwork.defaultConfirmations(rpc.network))
      const size = BigInt(maxBlockRange)
      return EvmIndexer.of({
        lastConfirmedBlock: rpc.blockNumber.pipe(Effect.map((head) => BigInt_.max(head - confirmations, BigInt(0)))),
        fetchLogs: (filter) =>
          Effect.gen(function*() {
            const logs: Array<EvmLog> = []
            for (let fromBlock = filter.fromBlock; fromBlock <= filter.toBlock; fromBlock += size) {
              const toBlock = BigInt_.min(fromBlock + size - BigInt(1), filter.toBlock)
              logs.push(...(yield* rpc.getLogs({ ...filter, fromBlock, toBlock })))
            }
            return logs
          })
      })
    })
  )
