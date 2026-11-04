import type * as JsonRpc from "@effect-blockchain/core/JsonRpc"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"
import { EvmAddress } from "../EvmAddress.ts"
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
export const getLogs = make({
  name: "eth_getLogs",
  params: Schema.Tuple([
    Schema.Struct({
      address: Schema.Array(EvmAddress),
      fromBlock: QuantityFromHex,
      toBlock: QuantityFromHex,
      // `topics: undefined` is accepted and omitted on encode, since `undefined` is not JSON
      topics: Schema.optionalKey(Schema.toEncoded(Topics)).pipe(
        Schema.decodeTo(
          Schema.optional(Topics),
          SchemaTransformation.transformOptional<typeof Topics.Encoded | undefined, typeof Topics.Encoded>({
            decode: (topics) => topics,
            encode: (topics) => Option.filter(topics, Predicate.isNotUndefined)
          })
        )
      )
    })
  ]),
  // a log dropped by a reorg comes back with `removed: true` and must not be returned
  result: Schema.Array(Schema.Struct({ ...EvmLog.fields, removed: Schema.optionalKey(Schema.Literal(false)) }))
})
