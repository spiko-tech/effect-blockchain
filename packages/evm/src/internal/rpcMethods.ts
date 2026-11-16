import * as JsonRpc from "@effect-blockchain/core/JsonRpc"
import * as Schema from "effect/Schema"
import { EvmAddress } from "../EvmAddress.ts"
import { EvmBlock } from "../EvmBlock.ts"
import { EvmFeeHistory } from "../EvmFeeHistory.ts"
import { EvmHexData } from "../EvmHexData.ts"
import { EvmLog } from "../EvmLog.ts"
import { EvmTransaction, EvmTransactionReceipt } from "../EvmTransaction.ts"
import { EvmTransactionHash } from "../EvmTransactionHash.ts"
import { IntFromHex, QuantityFromHex } from "./QuantityFromHex.ts"

const make = <Params, Result>(method: JsonRpc.Method<Params, Result>): JsonRpc.Method<Params, Result> => method

const NoParams = Schema.Tuple([])

const Topics = Schema.Array(Schema.NullOr(Schema.Union([EvmHexData, Schema.Array(EvmHexData)])))

const BlockTag = Schema.Literals(["latest", "pending"])

/** @internal */
export const chainId = make({ name: "eth_chainId", params: NoParams, result: IntFromHex })

/** @internal */
export const blockNumber = make({ name: "eth_blockNumber", params: NoParams, result: QuantityFromHex })

/** @internal */
export const getBlockByNumber = make({
  name: "eth_getBlockByNumber",
  // `false`: transaction hashes only, never the full transactions
  params: Schema.Tuple([QuantityFromHex, Schema.Literal(false)]),
  // `null` when the node does not know the block
  result: Schema.NullOr(EvmBlock)
})

/** @internal */
export const getBalance = make({
  name: "eth_getBalance",
  params: Schema.Tuple([EvmAddress, QuantityFromHex]),
  result: QuantityFromHex
})

/** @internal */
export const getLogs = make({
  name: "eth_getLogs",
  params: Schema.Tuple([
    Schema.Struct({
      address: Schema.Array(EvmAddress),
      fromBlock: QuantityFromHex,
      toBlock: QuantityFromHex,
      topics: JsonRpc.optionalOmitted(Topics)
    })
  ]),
  // a log dropped by a reorg comes back with `removed: true` and must not be returned
  result: Schema.Array(Schema.Struct({ ...EvmLog.fields, removed: Schema.optionalKey(Schema.Literal(false)) }))
})

/** @internal */
export const getTransactionByHash = make({
  name: "eth_getTransactionByHash",
  params: Schema.Tuple([EvmTransactionHash]),
  // `null` when the node does not know the transaction
  result: Schema.NullOr(EvmTransaction)
})

/** @internal */
export const getTransactionReceipt = make({
  name: "eth_getTransactionReceipt",
  params: Schema.Tuple([EvmTransactionHash]),
  // `null` until the transaction is in a block
  result: Schema.NullOr(EvmTransactionReceipt)
})

/** @internal */
export const sendRawTransaction = make({
  name: "eth_sendRawTransaction",
  params: Schema.Tuple([EvmHexData]),
  result: EvmTransactionHash
})

/** @internal */
export const getTransactionCount = make({
  name: "eth_getTransactionCount",
  params: Schema.Tuple([EvmAddress, BlockTag]),
  result: QuantityFromHex
})

/** @internal */
export const estimateGas = make({
  name: "eth_estimateGas",
  params: Schema.Tuple([
    Schema.Struct({
      from: EvmAddress,
      to: EvmAddress,
      value: JsonRpc.optionalOmitted(QuantityFromHex),
      data: JsonRpc.optionalOmitted(EvmHexData)
    })
  ]),
  result: QuantityFromHex
})

/** @internal */
export const feeHistory = make({
  name: "eth_feeHistory",
  params: Schema.Tuple([IntFromHex, BlockTag, Schema.Array(Schema.Number)]),
  result: EvmFeeHistory
})
