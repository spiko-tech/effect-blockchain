import * as Schema from "effect/Schema"
import { EvmAddress } from "../EvmAddress.ts"
import { EvmHexData } from "../EvmHexData.ts"
import { EvmLog } from "../EvmLog.ts"
import { IntFromHex, QuantityFromHex } from "./QuantityFromHex.ts"

/**
 * A JSON-RPC method: its name, the codec of its positional params and the codec of its result.
 *
 * @internal
 */
export interface RpcMethod<Params, Result> {
  readonly name: string
  readonly params: Schema.Codec<Params, ReadonlyArray<unknown>>
  readonly result: Schema.Codec<Result, unknown>
}

const make = <Params, Result>(method: RpcMethod<Params, Result>): RpcMethod<Params, Result> => method

const NoParams = Schema.Tuple([])

/** @internal */
export const chainId = make({ name: "eth_chainId", params: NoParams, result: IntFromHex })

/** @internal */
export const blockNumber = make({ name: "eth_blockNumber", params: NoParams, result: QuantityFromHex })

/** @internal */
export const getLogs = make({
  name: "eth_getLogs",
  params: Schema.Tuple([
    Schema.Struct({
      address: Schema.Union([EvmAddress, Schema.Array(EvmAddress)]),
      fromBlock: QuantityFromHex,
      toBlock: QuantityFromHex,
      topics: Schema.optional(Schema.Array(Schema.NullOr(Schema.Union([EvmHexData, Schema.Array(EvmHexData)]))))
    })
  ]),
  // a log dropped by a reorg comes back with `removed: true` and must not be returned
  result: Schema.Array(Schema.Struct({ ...EvmLog.fields, removed: Schema.optional(Schema.Literal(false)) }))
})
