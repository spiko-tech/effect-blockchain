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

// `StructWithRest` also runs the rest schema on the typed keys, whose decoded values are not all JSON (a `bigint` fee):
// `RpcJson` encodes those as they are, and the typed schema keeps their decoded value
const Rest = Schema.Record(Schema.String, Schema.Union([JsonFromRpc, RpcJson]))

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
    // the fields the library reads, typed, any other field (`transactionConfig` on version 1) kept raw
    message: Schema.StructWithRest(
      Schema.Struct({
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
        // absent from legacy and version 1 transactions
        addressTableLookups: Schema.optionalKey(Schema.Array(Schema.Struct({
          accountKey: SolanaAddress,
          writableIndexes: Indexes,
          readonlyIndexes: Indexes
        })))
      }),
      [Rest]
    )
  })
}

const Lamports = Schema.Array(Schema.BigInt)

// a field absent or `null` as the node's `OptionSerializer` writes it, see `UiTransactionStatusMeta` in
// https://github.com/anza-xyz/agave/blob/master/transaction-status-client-types/src/lib.rs
const optionalNullable = <S extends Schema.Top>(schema: S) => Schema.optionalKey(Schema.NullOr(schema))

const TokenBalances = Schema.Array(Schema.Struct({
  accountIndex: NumberFromBigInt,
  mint: SolanaAddress,
  owner: Schema.optionalKey(SolanaAddress),
  programId: Schema.optionalKey(SolanaAddress),
  // `uiAmount` (a float) and `uiAmountString` stay raw: both derive from `amount` and `decimals`
  uiTokenAmount: Schema.StructWithRest(
    Schema.Struct({ amount: Schema.BigIntFromString, decimals: NumberFromBigInt }),
    [Rest]
  )
}))

// the fields the library reads, typed, any other field of the status meta kept raw
const Meta = Schema.StructWithRest(
  Schema.Struct({
    err: JsonFromRpc,
    fee: Schema.BigInt,
    preBalances: Lamports,
    postBalances: Lamports,
    // absent from transactions older than versioned transactions
    loadedAddresses: Schema.optionalKey(Schema.Struct({
      writable: Schema.Array(SolanaAddress),
      readonly: Schema.Array(SolanaAddress)
    })),
    innerInstructions: optionalNullable(Schema.Array(Schema.Struct({
      index: NumberFromBigInt,
      instructions: Schema.Array(Schema.Struct({
        programIdIndex: NumberFromBigInt,
        accounts: Indexes,
        data: Schema.String,
        stackHeight: Schema.NullOr(NumberFromBigInt)
      }))
    }))),
    preTokenBalances: optionalNullable(TokenBalances),
    postTokenBalances: optionalNullable(TokenBalances)
  }),
  [Rest]
)

// the node's `InstructionError` and `TransactionError` as serde writes them: a variant without data is its name, one
// with data an object keyed by its name. Only the variants below are decoded, any other one is kept as raw JSON
const InstructionError = Schema.Union([
  Schema.String,
  Schema.Struct({ Custom: NumberFromBigInt }),
  Schema.Record(Schema.String, JsonFromRpc)
])

/** @internal */
export const TransactionError = Schema.Union([
  Schema.String,
  Schema.Struct({ InstructionError: Schema.Tuple([NumberFromBigInt, InstructionError]) }),
  Schema.Record(Schema.String, JsonFromRpc)
])

const NoParams = Schema.Tuple([])

const Commitment = Schema.Literals(["confirmed", "finalized"])

/** @internal */
export const getGenesisHash = JsonRpc.method({ name: "getGenesisHash", params: NoParams, result: Schema.String })

/** @internal */
export const getSlot = JsonRpc.method({
  name: "getSlot",
  params: Schema.Tuple([Schema.Struct({ commitment: Commitment })]),
  result: Schema.BigInt
})

/** @internal */
export const getBlockHeight = JsonRpc.method({
  name: "getBlockHeight",
  params: Schema.Tuple([Schema.Struct({ commitment: Commitment })]),
  result: Schema.BigInt
})

/** @internal */
export const getEpochInfo = JsonRpc.method({
  name: "getEpochInfo",
  params: Schema.Tuple([Schema.Struct({ commitment: Commitment })]),
  result: Schema.Struct({
    epoch: Schema.BigInt,
    slotIndex: Schema.BigInt,
    slotsInEpoch: Schema.BigInt,
    absoluteSlot: Schema.BigInt,
    blockHeight: Schema.BigInt
  })
})

/** @internal */
export const getSignatureStatuses = JsonRpc.method({
  name: "getSignatureStatuses",
  params: Schema.Tuple([
    Schema.Array(SolanaTransactionHash),
    Schema.Struct({ searchTransactionHistory: Schema.Boolean })
  ]),
  result: Schema.Struct({
    context: Schema.Struct({ slot: Schema.BigInt }),
    // `null` for a signature the endpoint does not know
    value: Schema.Array(Schema.NullOr(Schema.Struct({
      slot: Schema.BigInt,
      confirmations: Schema.NullOr(NumberFromBigInt),
      err: Schema.NullOr(TransactionError),
      confirmationStatus: Schema.NullOr(Schema.Literals(["processed", "confirmed", "finalized"]))
    })))
  })
})

/** @internal */
export const getBalance = JsonRpc.method({
  name: "getBalance",
  params: Schema.Tuple([SolanaAddress, Schema.Struct({ commitment: Commitment })]),
  result: Schema.Struct({ context: Schema.Struct({ slot: Schema.BigInt }), value: Schema.BigInt })
})

/** @internal */
export const getBlockTime = JsonRpc.method({
  name: "getBlockTime",
  params: Schema.Tuple([JsonRpc.BigIntFromInt]),
  // `null` when the node has no time for the block
  result: Schema.NullOr(Schema.BigInt)
})

/**
 * The largest `limit` of `getBlocksWithLimit`: `MAX_GET_CONFIRMED_BLOCKS_RANGE` in
 * https://github.com/anza-xyz/agave/blob/master/rpc-client-types/src/request.rs, above which `get_blocks_with_limit`
 * in https://github.com/anza-xyz/agave/blob/master/rpc/src/rpc.rs fails `-32602`.
 *
 * @internal
 */
export const maxBlocksLimit = 500_000

/** @internal */
export const getBlocksWithLimit = JsonRpc.method({
  name: "getBlocksWithLimit",
  params: Schema.Tuple([JsonRpc.BigIntFromInt, Schema.Int, Schema.Struct({ commitment: Commitment })]),
  result: Schema.Array(Schema.BigInt)
})

/** @internal */
export const getTokenAccountsByOwner = JsonRpc.method({
  name: "getTokenAccountsByOwner",
  params: Schema.Tuple([
    SolanaAddress,
    Schema.Union([Schema.Struct({ mint: SolanaAddress }), Schema.Struct({ programId: SolanaAddress })]),
    Schema.Struct({
      commitment: Commitment,
      encoding: Schema.Literal("base64"),
      // no account data: the reply lists the accounts only
      dataSlice: Schema.Struct({ offset: Schema.Literal(0), length: Schema.Literal(0) }),
      minContextSlot: JsonRpc.optionalOmitted(JsonRpc.BigIntFromInt)
    })
  ]),
  result: Schema.Struct({
    context: Schema.Struct({ slot: Schema.BigInt }),
    value: Schema.Array(Schema.Struct({
      pubkey: SolanaAddress,
      // `data`, `executable`, `rentEpoch` (u64, often its maximum) and `space` kept raw
      account: Schema.StructWithRest(Schema.Struct({ owner: SolanaAddress, lamports: Schema.BigInt }), [Rest])
    }))
  })
})

// the account `data` codec by encoding, checked against `SolanaAccountData` where `SolanaRpc.ts` uses it
const accountData = {
  base64: Schema.Tuple([Schema.String, Schema.Literal("base64")]),
  // the node answers the base64 tuple instead when it has no parser for the owner program
  jsonParsed: JsonFromRpc
}

/** @internal */
export const getAccountInfo = (encoding: keyof typeof accountData) =>
  JsonRpc.method({
    name: "getAccountInfo",
    params: Schema.Tuple([
      SolanaAddress,
      Schema.Struct({
        commitment: Commitment,
        encoding: Schema.Literal(encoding),
        minContextSlot: JsonRpc.optionalOmitted(JsonRpc.BigIntFromInt)
      })
    ]),
    result: Schema.Struct({
      context: Schema.Struct({ slot: Schema.BigInt }),
      // `null` for an address that holds no account; `rentEpoch` and `space` kept raw
      value: Schema.NullOr(Schema.StructWithRest(
        Schema.Struct({
          owner: SolanaAddress,
          lamports: Schema.BigInt,
          executable: Schema.Boolean,
          data: accountData[encoding]
        }),
        [Rest]
      ))
    })
  })

/** @internal */
export const getSignaturesForAddress = JsonRpc.method({
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

/**
 * The `maxSupportedTransactionVersion` of every `getTransaction`: a ceiling, the node answers legacy, version 0 and
 * version 1 transactions and fails `-32015` on a newer one.
 *
 * @internal
 */
export const maxSupportedTransactionVersion = 1

/** @internal */
export const getTransaction = (encoding: keyof typeof transactions) =>
  JsonRpc.method({
    name: "getTransaction",
    params: Schema.Tuple([
      SolanaTransactionHash,
      Schema.Struct({
        commitment: Commitment,
        encoding: Schema.Literal(encoding),
        maxSupportedTransactionVersion: Schema.Literal(maxSupportedTransactionVersion)
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

/** @internal */
export const getLatestBlockhash = JsonRpc.method({
  name: "getLatestBlockhash",
  params: Schema.Tuple([Schema.Struct({ commitment: Commitment })]),
  result: Schema.Struct({
    context: Schema.Struct({ slot: Schema.BigInt }),
    value: Schema.Struct({ blockhash: Schema.String, lastValidBlockHeight: Schema.BigInt })
  })
})

/** @internal */
export const simulateTransaction = JsonRpc.method({
  name: "simulateTransaction",
  params: Schema.Tuple([
    Schema.String,
    Schema.Struct({
      encoding: Schema.Literal("base64"),
      commitment: Commitment,
      sigVerify: JsonRpc.optionalOmitted(Schema.Boolean),
      replaceRecentBlockhash: JsonRpc.optionalOmitted(Schema.Boolean)
    })
  ]),
  result: Schema.Struct({
    context: Schema.Struct({ slot: Schema.BigInt }),
    value: Schema.Struct({
      err: Schema.NullOr(TransactionError),
      logs: Schema.NullOr(Schema.Array(Schema.String)),
      unitsConsumed: Schema.NullOr(Schema.BigInt)
    })
  })
})

/** @internal */
export const getRecentPrioritizationFees = JsonRpc.method({
  name: "getRecentPrioritizationFees",
  params: Schema.Tuple([Schema.Array(SolanaAddress)]),
  result: Schema.Array(Schema.Struct({ slot: Schema.BigInt, prioritizationFee: Schema.BigInt }))
})

/** @internal */
export const sendTransaction = JsonRpc.method({
  name: "sendTransaction",
  params: Schema.Tuple([
    Schema.String,
    Schema.Struct({
      encoding: Schema.Literal("base64"),
      skipPreflight: JsonRpc.optionalOmitted(Schema.Boolean),
      preflightCommitment: JsonRpc.optionalOmitted(Commitment),
      maxRetries: JsonRpc.optionalOmitted(Schema.Int)
    })
  ]),
  result: SolanaTransactionHash
})
