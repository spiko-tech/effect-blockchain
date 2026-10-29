/**
 * EVM event logs, as returned by `eth_getLogs`.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"
import { EvmAddress } from "./EvmAddress.ts"
import { EvmHexData } from "./EvmHexData.ts"
import { EvmTransactionHash } from "./EvmTransactionHash.ts"
import { IntFromHex, QuantityFromHex } from "./internal/QuantityFromHex.ts"

/**
 * A log emitted by a contract in a mined block, decoded from the raw JSON-RPC log: quantities are hex strings on the
 * encoded side (`"0x10"`) and `bigint` / `number` on the decoded side.
 *
 * A pending log (null block or transaction fields) does not decode. `logIndex` is the position of the log in its
 * block (EVM log indexes are per block, not per transaction).
 *
 * @since 0.1.0
 * @category schemas
 */
export const EvmLog = Schema.Struct({
  address: EvmAddress,
  topics: Schema.Array(EvmHexData),
  data: EvmHexData,
  blockNumber: QuantityFromHex,
  blockHash: EvmHexData,
  transactionHash: EvmTransactionHash,
  transactionIndex: IntFromHex,
  logIndex: IntFromHex
}).annotate({ identifier: "EvmLog", title: "EVM log" })

/**
 * @since 0.1.0
 * @category models
 */
export type EvmLog = typeof EvmLog.Type
