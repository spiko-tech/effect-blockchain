/**
 * EVM fee history, as returned by `eth_feeHistory`.
 *
 * @since 0.3.0
 */
import * as Schema from "effect/Schema"
import { QuantityFromHex } from "./internal/QuantityFromHex.ts"

/**
 * The fees of a range of blocks starting at `oldestBlock`, in wei per gas. `baseFeePerGas` has one more entry than
 * the range: the base fee of the block after it. `reward` holds, per block, the priority fee at each requested
 * percentile, and is absent when none was requested.
 *
 * @since 0.3.0
 * @category schemas
 */
export const EvmFeeHistory = Schema.Struct({
  oldestBlock: QuantityFromHex,
  baseFeePerGas: Schema.Array(QuantityFromHex),
  gasUsedRatio: Schema.Array(Schema.Number),
  reward: Schema.optionalKey(Schema.Array(Schema.Array(QuantityFromHex)))
}).annotate({ identifier: "EvmFeeHistory", title: "EVM fee history" })

/**
 * @since 0.3.0
 * @category models
 */
export type EvmFeeHistory = typeof EvmFeeHistory.Type
