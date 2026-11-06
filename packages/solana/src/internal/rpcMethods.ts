import type * as JsonRpc from "@effect-blockchain/core/JsonRpc"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"
import { SolanaAddress } from "../SolanaAddress.ts"
import type { SolanaEncodedTransaction, SolanaTransactionEncoding } from "../SolanaRpc.ts"
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

// `key: undefined` is accepted and omitted on encode, since `undefined` is not JSON
const optionalOmitted = <S extends Schema.Top>(schema: S) =>
  Schema.optionalKey(Schema.toEncoded(schema)).pipe(
    Schema.decodeTo(
      Schema.optional(schema),
      SchemaTransformation.transformOptional<S["Encoded"] | undefined, S["Encoded"]>({
        decode: (value) => value,
        encode: (value) => Option.filter(value, Predicate.isNotUndefined)
      })
    )
  )

// a `bigint` param sent as a JSON integer, e.g. a slot: encoding fails beyond the safe integers
const BigIntFromInt = Schema.Int.pipe(
  Schema.decodeTo(Schema.BigInt, SchemaTransformation.transform({ decode: BigInt, encode: Number }))
)

// a small JSON integer read as a `number`, e.g. an account index
const NumberFromBigInt = Schema.BigInt.pipe(
  Schema.decodeTo(Schema.Int, SchemaTransformation.transform({ decode: Number, encode: BigInt }))
)

const Indexes = Schema.Array(NumberFromBigInt)

const transactions: { readonly [E in SolanaTransactionEncoding]: Schema.Codec<SolanaEncodedTransaction[E], RpcJson> } =
  {
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
export const getSignaturesForAddress = make({
  name: "getSignaturesForAddress",
  params: Schema.Tuple([
    SolanaAddress,
    Schema.Struct({
      before: optionalOmitted(SolanaTransactionHash),
      until: optionalOmitted(SolanaTransactionHash),
      limit: optionalOmitted(Schema.Int),
      commitment: Commitment,
      minContextSlot: optionalOmitted(BigIntFromInt)
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
export const getTransaction = (encoding: SolanaTransactionEncoding) =>
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
      meta: JsonFromRpc
    }))
  })
