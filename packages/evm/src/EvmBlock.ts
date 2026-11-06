/**
 * EVM block headers, as returned by `eth_getBlockByNumber`.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"
import { EvmHexData } from "./EvmHexData.ts"
import { QuantityFromHex } from "./internal/QuantityFromHex.ts"

/**
 * The fields of a mined block that a caller needs to date its logs, decoded from the raw JSON-RPC block: quantities
 * are hex strings on the encoded side (`"0x10"`) and `bigint` on the decoded side. Every other field of the reply
 * (transactions, gas, bloom...) is ignored.
 *
 * `timestamp` is the block's Unix time in seconds, as the node returns it (multiply by 1000 for a JavaScript `Date`).
 *
 * @since 0.1.0
 * @category schemas
 */
export const EvmBlock = Schema.Struct({
  number: QuantityFromHex,
  hash: EvmHexData,
  parentHash: EvmHexData,
  timestamp: QuantityFromHex
}).annotate({ identifier: "EvmBlock", title: "EVM block" })

/**
 * @since 0.1.0
 * @category models
 */
export type EvmBlock = typeof EvmBlock.Type
