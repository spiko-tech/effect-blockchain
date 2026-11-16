/**
 * EVM transactions and their receipts, as returned by `eth_getTransactionByHash` and `eth_getTransactionReceipt`.
 *
 * @since 0.3.0
 */
import * as Schema from "effect/Schema"
import { EvmAddress } from "./EvmAddress.ts"
import { EvmHexData } from "./EvmHexData.ts"
import { EvmLog } from "./EvmLog.ts"
import { EvmTransactionHash } from "./EvmTransactionHash.ts"
import { IntFromHex, QuantityFromHex } from "./internal/QuantityFromHex.ts"

/**
 * A transaction known to a node, decoded from the raw JSON-RPC transaction. `blockNumber`, `blockHash` and
 * `transactionIndex` are `null` while it is pending, `to` is `null` for a contract creation. Every other field (the
 * fee fields, which depend on the transaction type, and the signature) is ignored.
 *
 * @since 0.3.0
 * @category schemas
 */
export const EvmTransaction = Schema.Struct({
  hash: EvmTransactionHash,
  from: EvmAddress,
  to: Schema.NullOr(EvmAddress),
  nonce: QuantityFromHex,
  value: QuantityFromHex,
  input: EvmHexData,
  gas: QuantityFromHex,
  blockNumber: Schema.NullOr(QuantityFromHex),
  blockHash: Schema.NullOr(EvmHexData),
  transactionIndex: Schema.NullOr(IntFromHex)
}).annotate({ identifier: "EvmTransaction", title: "EVM transaction" })

/**
 * @since 0.3.0
 * @category models
 */
export type EvmTransaction = typeof EvmTransaction.Type

/**
 * The receipt of a transaction included in a block. `status` is 1 for a success and 0 for a revert, and
 * `effectiveGasPrice` is in wei per gas. A receipt older than the Byzantium fork has no `status` and does not decode.
 *
 * @since 0.3.0
 * @category schemas
 */
export const EvmTransactionReceipt = Schema.Struct({
  transactionHash: EvmTransactionHash,
  transactionIndex: IntFromHex,
  blockNumber: QuantityFromHex,
  blockHash: EvmHexData,
  from: EvmAddress,
  to: Schema.NullOr(EvmAddress),
  status: IntFromHex.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  gasUsed: QuantityFromHex,
  effectiveGasPrice: QuantityFromHex,
  logs: Schema.Array(EvmLog)
}).annotate({ identifier: "EvmTransactionReceipt", title: "EVM transaction receipt" })

/**
 * @since 0.3.0
 * @category models
 */
export type EvmTransactionReceipt = typeof EvmTransactionReceipt.Type
