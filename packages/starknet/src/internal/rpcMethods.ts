import * as JsonRpc from "@effect-blockchain/core/JsonRpc"
import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"
import { StarknetAddress } from "../StarknetAddress.ts"
import { StarknetBlock } from "../StarknetBlock.ts"
import { StarknetEvent } from "../StarknetEvent.ts"
import { StarknetTransactionHash } from "../StarknetTransactionHash.ts"
import { PaddedFelt } from "./PaddedFelt.ts"

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

const BlockId = Schema.Struct({ block_number: JsonRpc.BigIntFromInt })

/** @internal */
export const chainId = make({ name: "starknet_chainId", params: NoParams, result: ShortStringFromFelt })

/** @internal */
export const blockNumber = make({ name: "starknet_blockNumber", params: NoParams, result: JsonRpc.BigIntFromInt })

/** @internal */
export const getBlockWithTxHashes = make({
  name: "starknet_getBlockWithTxHashes",
  params: Schema.Struct({ block_id: BlockId }),
  // a pre-confirmed block has no block hash and does not decode
  result: StarknetBlock
})

/** @internal */
export const call = make({
  name: "starknet_call",
  params: Schema.Struct({
    request: Schema.Struct({
      contract_address: StarknetAddress,
      entry_point_selector: Felt,
      calldata: Schema.Array(Felt)
    }),
    block_id: BlockId
  }),
  result: Schema.Array(PaddedFelt)
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
export const getTransactionStatus = make({
  name: "starknet_getTransactionStatus",
  params: Schema.Struct({ transaction_hash: StarknetTransactionHash }),
  result: Schema.Struct({
    finalityStatus: Schema.Literals(["RECEIVED", "CANDIDATE", "PRE_CONFIRMED", "ACCEPTED_ON_L2", "ACCEPTED_ON_L1"]),
    executionStatus: Schema.optionalKey(Schema.Literals(["SUCCEEDED", "REVERTED"])),
    failureReason: Schema.optionalKey(Schema.String)
  }).pipe(
    Schema.encodeKeys({
      finalityStatus: "finality_status",
      executionStatus: "execution_status",
      failureReason: "failure_reason"
    })
  )
})

/** @internal */
export const getTransactionReceipt = make({
  name: "starknet_getTransactionReceipt",
  params: Schema.Struct({ transaction_hash: StarknetTransactionHash }),
  // a pre-confirmed receipt has no block hash and does not decode
  result: Schema.Struct({
    transactionHash: StarknetTransactionHash,
    blockNumber: JsonRpc.BigIntFromInt,
    blockHash: PaddedFelt,
    events: Schema.Array(
      Schema.Struct({ fromAddress: StarknetAddress, keys: Schema.Array(PaddedFelt), data: Schema.Array(PaddedFelt) })
        .pipe(Schema.encodeKeys({ fromAddress: "from_address" }))
    )
  }).pipe(
    Schema.encodeKeys({ transactionHash: "transaction_hash", blockNumber: "block_number", blockHash: "block_hash" })
  )
})

// a felt holding an integer: a nonce, an amount of gas, a price
const BigIntFromFelt = Schema.String.check(Schema.isPattern(/^0x[0-9a-fA-F]{1,64}$/)).pipe(
  Schema.decodeTo(
    Schema.BigInt,
    SchemaTransformation.transform({ decode: BigInt, encode: (value) => `0x${value.toString(16)}` })
  )
)

const BlockTag = Schema.Literals(["latest", "pre_confirmed"])

const ResourceBound = Schema.Struct({ max_amount: BigIntFromFelt, max_price_per_unit: BigIntFromFelt })

const v3 = {
  version: Schema.Literal("0x3"),
  signature: Schema.Array(Felt),
  nonce: BigIntFromFelt,
  resource_bounds: Schema.Struct({ l1_gas: ResourceBound, l2_gas: ResourceBound, l1_data_gas: ResourceBound }),
  tip: BigIntFromFelt,
  paymaster_data: Schema.Tuple([]),
  nonce_data_availability_mode: Schema.Literal("L1"),
  fee_data_availability_mode: Schema.Literal("L1")
}

const InvokeTransaction = Schema.Struct({
  type: Schema.Literal("INVOKE"),
  sender_address: StarknetAddress,
  calldata: Schema.Array(Felt),
  account_deployment_data: Schema.Tuple([]),
  ...v3
})

const DeployAccountTransaction = Schema.Struct({
  type: Schema.Literal("DEPLOY_ACCOUNT"),
  class_hash: Felt,
  contract_address_salt: Felt,
  constructor_calldata: Schema.Array(Felt),
  ...v3
})

/** @internal */
export const getNonce = make({
  name: "starknet_getNonce",
  params: Schema.Struct({ block_id: BlockTag, contract_address: StarknetAddress }),
  result: BigIntFromFelt
})

/** @internal */
export const estimateFee = make({
  name: "starknet_estimateFee",
  params: Schema.Struct({
    request: Schema.Array(Schema.Union([InvokeTransaction, DeployAccountTransaction])),
    simulation_flags: Schema.Array(Schema.Literal("SKIP_VALIDATE")),
    block_id: BlockTag
  }),
  result: Schema.Array(
    Schema.Struct({
      l1GasConsumed: BigIntFromFelt,
      l1GasPrice: BigIntFromFelt,
      l1DataGasConsumed: BigIntFromFelt,
      l1DataGasPrice: BigIntFromFelt,
      l2GasConsumed: BigIntFromFelt,
      l2GasPrice: BigIntFromFelt,
      overallFee: BigIntFromFelt
    }).pipe(Schema.encodeKeys({
      l1GasConsumed: "l1_gas_consumed",
      l1GasPrice: "l1_gas_price",
      l1DataGasConsumed: "l1_data_gas_consumed",
      l1DataGasPrice: "l1_data_gas_price",
      l2GasConsumed: "l2_gas_consumed",
      l2GasPrice: "l2_gas_price",
      overallFee: "overall_fee"
    }))
  )
})

/** @internal */
export const addInvokeTransaction = make({
  name: "starknet_addInvokeTransaction",
  params: Schema.Struct({ invoke_transaction: InvokeTransaction }),
  result: Schema.Struct({ transactionHash: StarknetTransactionHash }).pipe(
    Schema.encodeKeys({ transactionHash: "transaction_hash" })
  )
})

/** @internal */
export const addDeployAccountTransaction = make({
  name: "starknet_addDeployAccountTransaction",
  params: Schema.Struct({ deploy_account_transaction: DeployAccountTransaction }),
  result: Schema.Struct({ transactionHash: StarknetTransactionHash, contractAddress: StarknetAddress }).pipe(
    Schema.encodeKeys({ transactionHash: "transaction_hash", contractAddress: "contract_address" })
  )
})
