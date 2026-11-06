/**
 * Starknet blocks, as returned by `starknet_getBlockWithTxHashes`.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"
import { BigIntFromInt } from "./internal/BigIntFromInt.ts"
import { PaddedFelt } from "./internal/felt.ts"
import { StarknetTransactionHash } from "./StarknetTransactionHash.ts"

/**
 * A confirmed block header with its transaction hashes, decoded from the raw JSON-RPC block: keys are snake case on
 * the encoded side (`block_hash`) and camel case on the decoded side, `block_number` and `timestamp` (unix seconds)
 * are JSON integers decoded to `bigint`s.
 *
 * `blockHash` and `parentHash` are felts as `0x` + 64 lowercase hex digits, `transactions` are in block order. A
 * pre-confirmed block (no block hash, no `ACCEPTED_ON_L2` or `ACCEPTED_ON_L1` status) does not decode.
 *
 * @example
 * ```ts
 * import type { StarknetEvent } from "@effect-blockchain/starknet/StarknetEvent"
 * import * as StarknetRpc from "@effect-blockchain/starknet/StarknetRpc"
 * import * as Effect from "effect/Effect"
 *
 * // the timestamp of each event, reading each block once
 * const withTimestamps = (events: ReadonlyArray<StarknetEvent>) =>
 *   Effect.gen(function*() {
 *     const rpc = yield* StarknetRpc.StarknetRpc
 *     const blockNumbers = [...new Set(events.map((event) => event.blockNumber))]
 *     const blocks = yield* Effect.forEach(blockNumbers, (blockNumber) => rpc.getBlockWithTxHashes({ blockNumber }), {
 *       concurrency: 5
 *     })
 *     const timestamps = new Map(blocks.map((block) => [block.blockNumber, block.timestamp]))
 *     return events.map((event) => ({ event, timestamp: timestamps.get(event.blockNumber) }))
 *   })
 * ```
 *
 * @since 0.1.0
 * @category schemas
 */
export const StarknetBlock = Schema.Struct({
  blockNumber: BigIntFromInt,
  blockHash: PaddedFelt,
  parentHash: PaddedFelt,
  timestamp: BigIntFromInt,
  status: Schema.Literals(["ACCEPTED_ON_L2", "ACCEPTED_ON_L1"]),
  transactions: Schema.Array(StarknetTransactionHash)
}).pipe(
  Schema.encodeKeys({ blockNumber: "block_number", blockHash: "block_hash", parentHash: "parent_hash" }),
  Schema.annotate({ identifier: "StarknetBlock", title: "Starknet block" })
)

/**
 * @since 0.1.0
 * @category models
 */
export type StarknetBlock = typeof StarknetBlock.Type
