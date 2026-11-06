import * as JsonRpc from "@effect-blockchain/core/JsonRpc"
import * as Schema from "effect/Schema"
import { EvmAddress } from "../EvmAddress.ts"
import { EvmBlock } from "../EvmBlock.ts"
import { EvmHexData } from "../EvmHexData.ts"
import { EvmLog } from "../EvmLog.ts"
import { IntFromHex, QuantityFromHex } from "./QuantityFromHex.ts"

const make = <Params, Result>(method: JsonRpc.Method<Params, Result>): JsonRpc.Method<Params, Result> => method

const NoParams = Schema.Tuple([])

const Topics = Schema.Array(Schema.NullOr(Schema.Union([EvmHexData, Schema.Array(EvmHexData)])))

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
