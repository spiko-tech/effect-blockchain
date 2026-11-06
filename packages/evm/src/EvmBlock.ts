/**
 * EVM block headers, as returned by `eth_getBlockByNumber`.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"
import { EvmHexData } from "./EvmHexData.ts"
import { QuantityFromHex } from "./internal/QuantityFromHex.ts"

/**
 * The header fields of a mined block, decoded from the raw JSON-RPC block with hex quantities (`"0x10"`) as `bigint`.
 * Every other field is ignored. `timestamp` is in Unix seconds.
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
