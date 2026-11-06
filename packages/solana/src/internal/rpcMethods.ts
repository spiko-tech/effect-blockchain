import * as JsonRpc from "@effect-blockchain/core/JsonRpc"
import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"
import { SolanaAddress } from "../SolanaAddress.ts"
import { SolanaTransactionHash } from "../SolanaTransactionHash.ts"

/**
 * JSON as `internal/bigIntJson.ts` reads it: every integer is a `bigint`, so u64 values stay exact.
 *
 * @internal
 */
export type RpcJson =
  | null
  | boolean
  | string
  | number
  | bigint
  | ReadonlyArray<RpcJson>
  | { readonly [key: string]: RpcJson }

const make = <Params, Result>(method: JsonRpc.Method<Params, Result, RpcJson>) => method

const RpcJson: Schema.Codec<RpcJson> = Schema.Union([
  Schema.Null,
  Schema.Boolean,
  Schema.String,
  Schema.Number,
  Schema.BigInt,
  Schema.Array(Schema.suspend(() => RpcJson)),
  Schema.Record(Schema.String, Schema.suspend(() => RpcJson))
])

const toJson = (value: RpcJson): Schema.Json => {
  if (typeof value === "bigint") return value.toString()
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(toJson)
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toJson(item)]))
}

// raw RPC data kept as JSON, every integer as a decimal string: exact, and storable as is
const JsonFromRpc = RpcJson.pipe(
  Schema.decodeTo(
    Schema.Json,
    SchemaTransformation.transform<Schema.Json, RpcJson>({ decode: toJson, encode: (json) => json })
  )
)

// a small JSON integer read as a `number`, e.g. an account index
const NumberFromBigInt = Schema.BigInt.pipe(
  Schema.decodeTo(Schema.Int, SchemaTransformation.transform({ decode: Number, encode: BigInt }))
)

const Indexes = Schema.Array(NumberFromBigInt)

// the `transaction` codec by encoding, checked against `SolanaEncodedTransaction` where `SolanaRpc.ts` uses it
const transactions = {
  base64: Schema.Tuple([Schema.String, Schema.Literal("base64")]).pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transform({ decode: ([data]) => data, encode: (data) => [data, "base64"] as const })
    )
  ),
  json: Schema.Struct({
    signatures: Schema.Array(SolanaTransactionHash),
    message: Schema.Struct({
      accountKeys: Schema.Array(SolanaAddress),
      header: Schema.Struct({
        numRequiredSignatures: NumberFromBigInt,
        numReadonlySignedAccounts: NumberFromBigInt,
        numReadonlyUnsignedAccounts: NumberFromBigInt
      }),
      recentBlockhash: Schema.String,
      instructions: Schema.Array(Schema.Struct({
        programIdIndex: NumberFromBigInt,
        accounts: Indexes,
        data: Schema.String
      })),
      // absent from legacy transactions
      addressTableLookups: Schema.optionalKey(Schema.Array(Schema.Struct({
        accountKey: SolanaAddress,
        writableIndexes: Indexes,
        readonlyIndexes: Indexes
      })))
    })
  })
}

const Lamports = Schema.Array(Schema.BigInt)

// the fields the balance helpers read, any other field of the status meta dropped
const Meta = Schema.Struct({
  err: JsonFromRpc,
  fee: Schema.BigInt,
  preBalances: Lamports,
  postBalances: Lamports,
  // absent from transactions older than versioned transactions
  loadedAddresses: Schema.optionalKey(Schema.Struct({
    writable: Schema.Array(SolanaAddress),
    readonly: Schema.Array(SolanaAddress)
  }))
})

const NoParams = Schema.Tuple([])

const Commitment = Schema.Literals(["confirmed", "finalized"])

/** @internal */
export const getGenesisHash = make({ name: "getGenesisHash", params: NoParams, result: Schema.String })

/** @internal */
export const getSlot = make({
  name: "getSlot",
  params: Schema.Tuple([Schema.Struct({ commitment: Commitment })]),
  result: Schema.BigInt
})

/** @internal */
export const getBalance = make({
  name: "getBalance",
  params: Schema.Tuple([SolanaAddress, Schema.Struct({ commitment: Commitment })]),
  result: Schema.Struct({ context: Schema.Struct({ slot: Schema.BigInt }), value: Schema.BigInt })
})

/** @internal */
export const getSignaturesForAddress = make({
  name: "getSignaturesForAddress",
  params: Schema.Tuple([
    SolanaAddress,
    Schema.Struct({
      before: JsonRpc.optionalOmitted(SolanaTransactionHash),
      until: JsonRpc.optionalOmitted(SolanaTransactionHash),
      limit: JsonRpc.optionalOmitted(Schema.Int),
      commitment: Commitment,
      minContextSlot: JsonRpc.optionalOmitted(JsonRpc.BigIntFromInt)
    })
  ]),
  result: Schema.Array(Schema.Struct({
    signature: SolanaTransactionHash,
    slot: Schema.BigInt,
    blockTime: Schema.NullOr(Schema.BigInt),
    err: JsonFromRpc,
    memo: Schema.NullOr(Schema.String)
  }))
})

/** @internal */
export const getTransaction = (encoding: keyof typeof transactions) =>
  make({
    name: "getTransaction",
    params: Schema.Tuple([
      SolanaTransactionHash,
      Schema.Struct({
        commitment: Commitment,
        encoding: Schema.Literal(encoding),
        maxSupportedTransactionVersion: Schema.Literal(0)
      })
    ]),
    // `null` when the endpoint does not have the transaction
    result: Schema.NullOr(Schema.Struct({
      slot: Schema.BigInt,
      blockTime: Schema.NullOr(Schema.BigInt),
      transaction: transactions[encoding],
      meta: Schema.NullOr(Meta)
    }))
  })
