import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
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

/**
 * A JSON-RPC method: its name, the codec of its positional params and the codec of its result.
 *
 * @internal
 */
export interface RpcMethod<Params, Result> {
  readonly name: string
  readonly params: Schema.Codec<Params, ReadonlyArray<Schema.Json>>
  readonly result: Schema.Codec<Result, RpcJson>
}

const make = <Params, Result>(method: RpcMethod<Params, Result>): RpcMethod<Params, Result> => method

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

const NoParams = Schema.Tuple([])

const Commitment = Schema.Literals(["confirmed", "finalized"])

/** @internal */
export const ErrorReply = Schema.Struct({
  error: Schema.Struct({
    code: Schema.Union([Schema.BigInt, Schema.Number]),
    message: Schema.String,
    data: Schema.optionalKey(RpcJson)
  })
})

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
export const getTransaction = make({
  name: "getTransaction",
  params: Schema.Tuple([
    SolanaTransactionHash,
    Schema.Struct({
      commitment: Commitment,
      encoding: Schema.Literal("base64"),
      maxSupportedTransactionVersion: Schema.Literal(0)
    })
  ]),
  // `null` when the endpoint does not have the transaction
  result: Schema.NullOr(Schema.Struct({
    slot: Schema.BigInt,
    blockTime: Schema.NullOr(Schema.BigInt),
    transaction: Schema.Tuple([Schema.String, Schema.Literal("base64")]),
    meta: JsonFromRpc
  }))
})
