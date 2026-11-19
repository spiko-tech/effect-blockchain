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

const NoParams = Schema.Tuple([])

const Topics = Schema.Array(Schema.NullOr(Schema.Union([EvmHexData, Schema.Array(EvmHexData)])))

const BlockTag = Schema.Literals(["latest", "pending"])

/** @internal */
export const chainId = JsonRpc.method({ name: "eth_chainId", params: NoParams, result: IntFromHex })

/** @internal */
export const blockNumber = JsonRpc.method({ name: "eth_blockNumber", params: NoParams, result: QuantityFromHex })

/** @internal */
export const getBlockByNumber = JsonRpc.method({
  name: "eth_getBlockByNumber",
  // `false`: transaction hashes only, never the full transactions
  params: Schema.Tuple([QuantityFromHex, Schema.Literal(false)]),
  // `null` when the node does not know the block
  result: Schema.NullOr(EvmBlock)
})

/** @internal */
export const getBalance = JsonRpc.method({
  name: "eth_getBalance",
  params: Schema.Tuple([EvmAddress, QuantityFromHex]),
  result: QuantityFromHex
})

/** @internal */
export const getLogs = JsonRpc.method({
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
export const getTransactionByHash = JsonRpc.method({
  name: "eth_getTransactionByHash",
  params: Schema.Tuple([EvmTransactionHash]),
  // `null` when the node does not know the transaction
  result: Schema.NullOr(EvmTransaction)
})

/** @internal */
export const getTransactionReceipt = JsonRpc.method({
  name: "eth_getTransactionReceipt",
  params: Schema.Tuple([EvmTransactionHash]),
  // `null` until the transaction is in a block
  result: Schema.NullOr(EvmTransactionReceipt)
})

/** @internal */
export const sendRawTransaction = JsonRpc.method({
  name: "eth_sendRawTransaction",
  params: Schema.Tuple([EvmHexData]),
  result: EvmTransactionHash
})

/** @internal */
export const getTransactionCount = JsonRpc.method({
  name: "eth_getTransactionCount",
  params: Schema.Tuple([EvmAddress, BlockTag]),
  result: QuantityFromHex
})

/** @internal */
export const estimateGas = JsonRpc.method({
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
export const call = JsonRpc.method({
  name: "eth_call",
  params: Schema.Tuple([
    Schema.Struct({ from: JsonRpc.optionalOmitted(EvmAddress), to: EvmAddress, data: EvmHexData }),
    BlockTag
  ]),
  result: EvmHexData
})

/** @internal */
export const feeHistory = JsonRpc.method({
  name: "eth_feeHistory",
  params: Schema.Tuple([IntFromHex, BlockTag, Schema.Array(Schema.Number)]),
  result: EvmFeeHistory
})
