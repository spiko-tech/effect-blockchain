/**
 * Starknet events, as returned by `starknet_getEvents`.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"
import { BigIntFromInt } from "./internal/BigIntFromInt.ts"
import { PaddedFelt } from "./internal/felt.ts"
import { StarknetAddress } from "./StarknetAddress.ts"
import { StarknetTransactionHash } from "./StarknetTransactionHash.ts"

/**
 * An event emitted by a contract in a block, decoded from the raw JSON-RPC event (snake case keys, felts as `0x` + 64
 * lowercase hex digits). A pre-confirmed event (no block hash or block number) does not decode. `transactionIndex` and
 * `eventIndex` (the event's position in its transaction) are only returned by RPC 0.10 and later.
 *
 * @since 0.1.0
 * @category schemas
 */
export const StarknetEvent = Schema.Struct({
  fromAddress: StarknetAddress,
  keys: Schema.Array(PaddedFelt),
  data: Schema.Array(PaddedFelt),
  blockNumber: BigIntFromInt,
  blockHash: PaddedFelt,
  transactionHash: StarknetTransactionHash,
  transactionIndex: Schema.optionalKey(Schema.Int),
  eventIndex: Schema.optionalKey(Schema.Int)
}).pipe(
  Schema.encodeKeys({
    fromAddress: "from_address",
    blockNumber: "block_number",
    blockHash: "block_hash",
    transactionHash: "transaction_hash",
    transactionIndex: "transaction_index",
    eventIndex: "event_index"
  }),
  Schema.annotate({ identifier: "StarknetEvent", title: "Starknet event" })
)

/**
 * @since 0.1.0
 * @category models
 */
export type StarknetEvent = typeof StarknetEvent.Type
