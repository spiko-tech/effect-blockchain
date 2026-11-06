import type * as JsonRpc from "@effect-blockchain/core/JsonRpc"
import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"
import { StarknetAddress } from "../StarknetAddress.ts"
import { StarknetBlock } from "../StarknetBlock.ts"
import { StarknetEvent } from "../StarknetEvent.ts"
import { StarknetTransactionHash } from "../StarknetTransactionHash.ts"
import { BigIntFromInt } from "./BigIntFromInt.ts"
import { PaddedFelt } from "./felt.ts"

// by-name params: every method sends an object, `{}` when it takes none
const make = <Params, Result>(method: JsonRpc.Method<Params, Result>): JsonRpc.Method<Params, Result> => method

const NoParams = Schema.Struct({})

const decodeShortString = (felt: string) => {
  const hex = BigInt(felt).toString(16)
  return hex.padStart(hex.length + hex.length % 2, "0").replace(
    /../g,
    (byte) => String.fromCharCode(parseInt(byte, 16))
  )
}

const encodeShortString = (text: string) =>
  `0x${Array.from(text, (char) => char.charCodeAt(0).toString(16).padStart(2, "0")).join("")}`

// a chain ID is a short string encoded as a felt: "0x534e5f4d41494e" is "SN_MAIN"
const ShortStringFromFelt = Schema.String.check(Schema.isPattern(/^0x[0-9a-fA-F]{1,64}$/)).pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transform({ decode: decodeShortString, encode: encodeShortString })
  )
)

// params accept any felt (`0x1`), results are normalized to 64 digits
const Felt = Schema.toEncoded(PaddedFelt)

const BlockId = Schema.Struct({ block_number: BigIntFromInt })

/** @internal */
export const chainId = make({ name: "starknet_chainId", params: NoParams, result: ShortStringFromFelt })

/** @internal */
export const blockNumber = make({ name: "starknet_blockNumber", params: NoParams, result: BigIntFromInt })

/** @internal */
export const getBlockWithTxHashes = make({
  name: "starknet_getBlockWithTxHashes",
  params: Schema.Struct({ block_id: BlockId }),
  // a pre-confirmed block has no block hash and does not decode
  result: StarknetBlock
})

/** @internal */
export const getEvents = make({
  name: "starknet_getEvents",
  params: Schema.Struct({
    filter: Schema.Struct({
      address: StarknetAddress,
      from_block: BlockId,
      to_block: BlockId,
      keys: Schema.optionalKey(Schema.Array(Schema.Array(Felt))),
      chunk_size: Schema.Int,
      continuation_token: Schema.optionalKey(Schema.String)
    })
  }),
  result: Schema.Struct({
    events: Schema.Array(StarknetEvent),
    continuation_token: Schema.optionalKey(Schema.String)
  })
})

/** @internal */
export const getTransactionReceipt = make({
  name: "starknet_getTransactionReceipt",
  params: Schema.Struct({ transaction_hash: StarknetTransactionHash }),
  // a pre-confirmed receipt has no block hash and does not decode
  result: Schema.Struct({
    transactionHash: StarknetTransactionHash,
    blockNumber: BigIntFromInt,
    blockHash: PaddedFelt,
    events: Schema.Array(
      Schema.Struct({ fromAddress: StarknetAddress, keys: Schema.Array(PaddedFelt), data: Schema.Array(PaddedFelt) })
        .pipe(Schema.encodeKeys({ fromAddress: "from_address" }))
    )
  }).pipe(
    Schema.encodeKeys({ transactionHash: "transaction_hash", blockNumber: "block_number", blockHash: "block_hash" })
  )
})
