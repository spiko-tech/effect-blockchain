/**
 * The Solana JSON-RPC methods over an ordered list of endpoints with fallback, one request per call. Every JSON
 * integer of a reply is read as an exact `bigint`, so lamport amounts above 2^53 are never rounded. The fallback
 * rules and the error reasons are described in
 * [Concepts](https://github.com/spiko-tech/effect-blockchain/blob/main/docs/concepts.md#endpoint-fallback).
 *
 * @example
 * ```ts
 * import type { SolanaAddress } from "@effect-blockchain/solana/SolanaAddress"
 * import * as SolanaRpc from "@effect-blockchain/solana/SolanaRpc"
 * import * as Effect from "effect/Effect"
 *
 * declare const address: SolanaAddress
 *
 * // the 10 latest finalized transactions touching `address`
 * const latest = Effect.gen(function*() {
 *   const rpc = yield* SolanaRpc.SolanaRpc
 *   const signatures = yield* rpc.getSignaturesForAddress({ address, limit: 10, commitment: "finalized" })
 *   return yield* Effect.forEach(signatures, ({ signature }) =>
 *     rpc.getTransaction({ signature, commitment: "finalized" }))
 * })
 * ```
 *
 * @since 0.1.0
 */
import * as JsonRpc from "@effect-blockchain/core/JsonRpc"
import {
  SOLANA_ERROR__JSON_RPC__INTERNAL_ERROR,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_BLOCK_CLEANED_UP,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_BLOCK_NOT_AVAILABLE,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_BLOCK_STATUS_NOT_AVAILABLE_YET,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_KEY_EXCLUDED_FROM_SECONDARY_INDEX,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_LONG_TERM_STORAGE_SLOT_SKIPPED,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_LONG_TERM_STORAGE_UNREACHABLE,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SLOT_SKIPPED,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_TRANSACTION_HISTORY_NOT_AVAILABLE
} from "@solana/kit"
import type * as Arr from "effect/Array"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import type * as HttpClient from "effect/http/HttpClient"
import * as Layer from "effect/Layer"
import type * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as BigIntJson from "./internal/bigIntJson.ts"
import * as RpcMethods from "./internal/rpcMethods.ts"
import type { SolanaAddress } from "./SolanaAddress.ts"
import { type SolanaGenesisHash, type SolanaNetwork, toGenesisHash } from "./SolanaNetwork.ts"
import type { SolanaTransactionHash } from "./SolanaTransactionHash.ts"

/**
 * A JSON-RPC endpoint. The `name` is shown in errors and spans, the `url` is never logged.
 *
 * @since 0.1.0
 * @category models
 */
export interface SolanaRpcEndpoint {
  readonly name: string
  readonly url: Redacted.Redacted<string>
}

/**
 * A failed call, with a {@link JsonRpc.Reason} as `reason`.
 *
 * On Solana, `Unavailable` includes the codes 429, -32603, -32005 and -32019, `Lagging` a `minContextSlot` not reached
 * or a block not available yet, and `Pruned` a cleaned-up or skipped slot or a `getTransaction` returning `null`.
 *
 * @since 0.1.0
 * @category errors
 */
export class SolanaRpcError extends Schema.TaggedError<SolanaRpcError>()("SolanaRpcError", {
  reason: JsonRpc.Reason,
  method: Schema.String,
  endpoint: Schema.String,
  code: Schema.optional(Schema.Number),
  cause: Schema.Defect()
}) {
  /**
   * @since 0.1.0
   */
  override get message(): string {
    return `${this.method} failed on ${this.endpoint}: ${this.reason._tag}${
      this.code === undefined ? "" : ` (${this.code})`
    }`
  }
}

/**
 * The commitment a read waits for. `processed` is left out: a processed block can still be dropped.
 *
 * @since 0.1.0
 * @category models
 */
export type SolanaCommitment = "confirmed" | "finalized"

/**
 * One `getSignaturesForAddress` page: signatures touching `address`, newest first, older than `before` and newer than
 * `until` when given, at most `limit` (the node's default and maximum is 1000).
 *
 * @since 0.1.0
 * @category models
 */
export interface SolanaSignaturesQuery {
  readonly address: SolanaAddress
  readonly before?: SolanaTransactionHash | undefined
  readonly until?: SolanaTransactionHash | undefined
  readonly limit?: number | undefined
  readonly commitment: SolanaCommitment
  /**
   * An endpoint that honours it answers `Lagging` until it has reached this slot. Some providers ignore it and answer
   * from wherever they are, so a caller that needs the guarantee checks the head itself, e.g. with `getSlot`.
   */
  readonly minContextSlot?: bigint | undefined
}

/**
 * A `getSignaturesForAddress` entry. `blockTime` is a Unix timestamp in seconds, `null` when the node does not know
 * it. `err` is the raw transaction error as JSON (integers as decimal strings), `null` when the transaction succeeded.
 *
 * @since 0.1.0
 * @category models
 */
export interface SolanaSignatureInfo {
  readonly signature: SolanaTransactionHash
  readonly slot: bigint
  readonly blockTime: bigint | null
  readonly err: Schema.Json
  readonly memo: string | null
}

/**
 * The `getTransaction` encodings. `base64` is the signed wire transaction, for the `@solana/kit` decoders (e.g.
 * `getTransactionDecoder`, which decodes version 1 in `@solana/kit` 8.6.0, where `TransactionVersion` is
 * `'legacy' | 0 | 1`) and for storing the exact bytes. `json` splits it into signatures, account keys and compiled
 * instructions; `jsonParsed` is not offered, as its shape depends on the programs the node knows.
 *
 * @since 0.1.0
 * @category models
 */
export type SolanaTransactionEncoding = "base64" | "json"

/**
 * A compiled instruction of a `json` transaction: `programIdIndex` and `accounts` index the message's account keys,
 * followed by the addresses loaded from the lookup tables (writable then readonly), and `data` is base58.
 *
 * @since 0.1.0
 * @category models
 */
export type SolanaCompiledInstruction = {
  readonly programIdIndex: number
  readonly accounts: ReadonlyArray<number>
  readonly data: string
}

/**
 * A `json` transaction. `addressTableLookups` is absent from legacy and version 1 transactions, and every other message
 * field (`transactionConfig` on version 1) is kept as raw JSON, integers as decimal strings.
 *
 * @since 0.1.0
 * @category models
 */
export interface SolanaJsonTransaction {
  readonly signatures: ReadonlyArray<SolanaTransactionHash>
  readonly message: {
    readonly accountKeys: ReadonlyArray<SolanaAddress>
    readonly header: {
      readonly numRequiredSignatures: number
      readonly numReadonlySignedAccounts: number
      readonly numReadonlyUnsignedAccounts: number
    }
    readonly recentBlockhash: string
    readonly instructions: ReadonlyArray<SolanaCompiledInstruction>
    readonly addressTableLookups?: ReadonlyArray<{
      readonly accountKey: SolanaAddress
      readonly writableIndexes: ReadonlyArray<number>
      readonly readonlyIndexes: ReadonlyArray<number>
    }>
    readonly [field: string]: SolanaRpcJson | undefined
  }
}

/**
 * The `transaction` of a `getTransaction` result, by encoding: the base64 wire transaction or a
 * {@link SolanaJsonTransaction}.
 *
 * @since 0.1.0
 * @category models
 */
export interface SolanaEncodedTransaction {
  readonly base64: string
  readonly json: SolanaJsonTransaction
}

/**
 * JSON as the node writes it, with every integer read as a `bigint` so that u64 values stay exact.
 *
 * @since 0.3.0
 * @category models
 */
export type SolanaRpcJson =
  | null
  | boolean
  | string
  | number
  | bigint
  | ReadonlyArray<SolanaRpcJson>
  | { readonly [key: string]: SolanaRpcJson }

/**
 * An instruction a program invoked through a cross-program invocation, compiled like a {@link SolanaCompiledInstruction}.
 * `stackHeight` is 2 for an instruction invoked by a top-level one, and so on, `null` on transactions recorded before the
 * node tracked it.
 *
 * @since 0.3.0
 * @category models
 */
export type SolanaInnerInstruction = {
  readonly programIdIndex: number
  readonly accounts: ReadonlyArray<number>
  readonly data: string
  readonly stackHeight: number | null
}

/**
 * The token balance of an account in a transaction: `accountIndex` follows the account keys, then the loaded addresses.
 * `uiTokenAmount` types the exact `amount` in base units and the mint's `decimals`, and keeps its other fields
 * (`uiAmount`, `uiAmountString`) as raw JSON.
 *
 * @since 0.3.0
 * @category models
 */
export type SolanaTokenBalance = {
  readonly accountIndex: number
  readonly mint: SolanaAddress
  readonly owner?: SolanaAddress
  readonly programId?: SolanaAddress
  readonly uiTokenAmount: {
    readonly amount: bigint
    readonly decimals: number
    readonly [field: string]: SolanaRpcJson
  }
}

/**
 * The status meta of a transaction. `err` is the raw transaction error as JSON (integers as decimal strings), `null`
 * when it succeeded. `preBalances` and `postBalances` follow the account keys, then `loadedAddresses` (absent from
 * transactions older than versioned transactions). `innerInstructions`, `preTokenBalances` and `postTokenBalances`
 * are absent or `null` when the node did not record them. Every other field (`logMessages`, `computeUnitsConsumed`,
 * `rewards`...) is kept as raw JSON, integers as decimal strings.
 *
 * @since 0.2.0
 * @category models
 */
export interface SolanaTransactionMeta {
  readonly err: Schema.Json
  readonly fee: bigint
  readonly preBalances: ReadonlyArray<bigint>
  readonly postBalances: ReadonlyArray<bigint>
  readonly loadedAddresses?: {
    readonly writable: ReadonlyArray<SolanaAddress>
    readonly readonly: ReadonlyArray<SolanaAddress>
  }
  readonly innerInstructions?:
    | ReadonlyArray<{
      readonly index: number
      readonly instructions: ReadonlyArray<SolanaInnerInstruction>
    }>
    | null
  readonly preTokenBalances?: ReadonlyArray<SolanaTokenBalance> | null
  readonly postTokenBalances?: ReadonlyArray<SolanaTokenBalance> | null
  readonly [field: string]: SolanaRpcJson | undefined
}

/**
 * A `getTransaction` result. `transaction` follows the requested encoding (see {@link SolanaEncodedTransaction}).
 * `meta` is `null` when the node does not have it.
 *
 * @since 0.1.0
 * @category models
 */
export interface SolanaTransactionInfo<Encoding extends SolanaTransactionEncoding = "base64"> {
  readonly slot: bigint
  readonly blockTime: bigint | null
  readonly transaction: SolanaEncodedTransaction[Encoding]
  readonly meta: SolanaTransactionMeta | null
}

/**
 * A `getBalance` result: the lamports of the account (`value`) at the context `slot`.
 *
 * @since 0.2.0
 * @category models
 */
export interface SolanaBalance {
  readonly slot: bigint
  readonly value: bigint
}

/**
 * A `getTokenAccountsByOwner` entry: the token account at `pubkey`, without its data. `owner` is its token program and
 * `lamports` its balance, every other field (`executable`, `rentEpoch`, `space`...) is kept as raw JSON, integers as
 * decimal strings.
 *
 * @since 0.4.0
 * @category models
 */
export interface SolanaTokenAccount {
  readonly pubkey: SolanaAddress
  readonly account: {
    readonly owner: SolanaAddress
    readonly lamports: bigint
    readonly [field: string]: SolanaRpcJson
  }
}

/**
 * A `getTokenAccountsByOwner` result: the token accounts (`value`) at the context `slot`.
 *
 * @since 0.4.0
 * @category models
 */
export interface SolanaTokenAccounts {
  readonly slot: bigint
  readonly value: ReadonlyArray<SolanaTokenAccount>
}

/**
 * The `getAccountInfo` encodings of the account data.
 *
 * @since 0.5.0
 * @category models
 */
export type SolanaAccountEncoding = "base64" | "jsonParsed"

/**
 * The `data` of an account, by encoding: the `[data, "base64"]` tuple, or the node's parsed account as raw JSON
 * (integers as decimal strings). With `jsonParsed`, a node without a parser for the owner program answers the base64
 * tuple, see `encode_ui_account` in https://github.com/anza-xyz/agave/blob/master/account-decoder/src/lib.rs.
 *
 * @since 0.5.0
 * @category models
 */
export interface SolanaAccountData {
  readonly base64: readonly [data: string, encoding: "base64"]
  readonly jsonParsed: Schema.Json
}

/**
 * An account: its owner program, its balance in lamports, whether it holds a program, and its `data` in the requested
 * encoding. Every other field (`rentEpoch`, `space`...) is kept as raw JSON, integers as decimal strings.
 *
 * @since 0.5.0
 * @category models
 */
export interface SolanaAccount<Encoding extends SolanaAccountEncoding = SolanaAccountEncoding> {
  readonly owner: SolanaAddress
  readonly lamports: bigint
  readonly executable: boolean
  readonly data: SolanaAccountData[Encoding]
  readonly [field: string]: SolanaRpcJson
}

/**
 * A `getAccountInfo` result: the account (`value`) at the context `slot`, `null` when the address holds none.
 *
 * @since 0.5.0
 * @category models
 */
export interface SolanaAccountInfo<Encoding extends SolanaAccountEncoding = SolanaAccountEncoding> {
  readonly slot: bigint
  readonly value: SolanaAccount<Encoding> | null
}

/**
 * A `getEpochInfo` result: the `absoluteSlot` and `blockHeight` of one bank of the answering endpoint, and where that
 * slot stands in its `epoch` (`slotIndex` of `slotsInEpoch`).
 *
 * @since 0.3.0
 * @category models
 */
export interface SolanaEpochInfo {
  readonly epoch: bigint
  readonly slotIndex: bigint
  readonly slotsInEpoch: bigint
  readonly absoluteSlot: bigint
  readonly blockHeight: bigint
}

/**
 * Why an instruction failed, as the node returns it: the variant's name (`"ProgramFailedToComplete"`), the program's
 * own error code (`{ Custom: 6001 }`), or any other variant carrying data as raw JSON (integers as decimal strings).
 *
 * @since 0.2.0
 * @category models
 */
export type SolanaInstructionError =
  | string
  | { readonly Custom: number }
  | { readonly [variant: string]: Schema.Json }

/**
 * Why a transaction failed, as the node returns it: the variant's name (`"BlockhashNotFound"`), the failing
 * instruction's index and error (`{ InstructionError: [2, { Custom: 6001 }] }`), or any other variant carrying data
 * as raw JSON (integers as decimal strings).
 *
 * @since 0.2.0
 * @category models
 */
export type SolanaTransactionError =
  | string
  | { readonly InstructionError: readonly [index: number, error: SolanaInstructionError] }
  | { readonly [variant: string]: Schema.Json }

/**
 * A `getSignatureStatuses` entry: the `slot` holding the transaction, its `err` (`null` when it succeeded) and the
 * commitment its block has reached. `confirmations` counts the blocks built on it, `null` once it is finalized.
 *
 * @since 0.2.0
 * @category models
 */
export interface SolanaSignatureStatus {
  readonly slot: bigint
  readonly confirmations: number | null
  readonly err: SolanaTransactionError | null
  readonly confirmationStatus: "processed" | "confirmed" | "finalized" | null
}

/**
 * A `getSignatureStatuses` result: one entry of `value` per signature, in order, `null` for a signature the endpoint
 * does not know, as seen at the context `slot`.
 *
 * @since 0.2.0
 * @category models
 */
export interface SolanaSignatureStatuses {
  readonly slot: bigint
  readonly value: ReadonlyArray<SolanaSignatureStatus | null>
}

/**
 * A `getLatestBlockhash` result at the context `slot`: a transaction signed with `blockhash` can land while the block
 * height is at most `lastValidBlockHeight`.
 *
 * @since 0.2.0
 * @category models
 */
export interface SolanaLatestBlockhash {
  readonly slot: bigint
  readonly blockhash: string
  readonly lastValidBlockHeight: bigint
}

/**
 * A `simulateTransaction` result at the context `slot`: `err` is `null` when the transaction would succeed, `logs` the
 * program logs and `unitsConsumed` the compute units used, both `null` when the simulation did not run.
 *
 * @since 0.2.0
 * @category models
 */
export interface SolanaSimulation {
  readonly slot: bigint
  readonly err: SolanaTransactionError | null
  readonly logs: ReadonlyArray<string> | null
  readonly unitsConsumed: bigint | null
}

/**
 * A `getRecentPrioritizationFees` entry: the lowest compute unit price, in micro-lamports, of a transaction that
 * landed in `slot` and locked the queried accounts. It is 0 for a slot where such a transaction paid none.
 *
 * @since 0.2.0
 * @category models
 */
export interface SolanaPrioritizationFee {
  readonly slot: bigint
  readonly prioritizationFee: bigint
}

/**
 * The `getTransaction` options.
 *
 * @since 0.1.0
 * @category models
 */
export interface SolanaTransactionQuery {
  readonly signature: SolanaTransactionHash
  readonly commitment: SolanaCommitment
}

/**
 * @since 0.1.0
 * @category services
 */
export class SolanaRpc extends Context.Service<SolanaRpc, {
  readonly network: SolanaNetwork
  /** `getGenesisHash`, verified against `network` once per endpoint then served from that check. */
  readonly getGenesisHash: Effect.Effect<SolanaGenesisHash, SolanaRpcError>
  /** `getSlot` */
  readonly getSlot: (options: {
    readonly commitment: SolanaCommitment
  }) => Effect.Effect<bigint, SolanaRpcError>
  /** `getBlockHeight`: the number of blocks below the head, lower than its slot as skipped slots hold no block. */
  readonly getBlockHeight: (options: {
    readonly commitment: SolanaCommitment
  }) => Effect.Effect<bigint, SolanaRpcError>
  /** `getEpochInfo`: unlike `getSlot` and `getBlockHeight`, the slot and the block height come from one bank. */
  readonly getEpochInfo: (options: {
    readonly commitment: SolanaCommitment
  }) => Effect.Effect<SolanaEpochInfo, SolanaRpcError>
  /**
   * `getBlockTime`: the estimated production time of the block at `slot` in Unix seconds, `null` when the node has no
   * time for it. A skipped slot fails `Pruned` (`-32007`, or `-32009` from long-term storage, where some providers
   * answer `null` instead), and a slot not produced yet fails `Lagging` (`-32004`).
   */
  readonly getBlockTime: (options: {
    readonly slot: bigint
  }) => Effect.Effect<bigint | null, SolanaRpcError>
  /**
   * `getBlocksWithLimit`: the produced slots from `startSlot` on, ascending, at most `limit`. A `limit` above the
   * node's maximum of 500,000 fails `Rejected` before any request.
   */
  readonly getBlocksWithLimit: (options: {
    readonly startSlot: bigint
    readonly limit: number
    readonly commitment: SolanaCommitment
  }) => Effect.Effect<ReadonlyArray<bigint>, SolanaRpcError>
  /**
   * `getTokenAccountsByOwner`: the token accounts of `owner` holding `mint`, or owned by the token program
   * `programId`, without their data. `minContextSlot` works as in {@link SolanaSignaturesQuery}.
   */
  readonly getTokenAccountsByOwner: (options: {
    readonly owner: SolanaAddress
    readonly filter: { readonly mint: SolanaAddress } | { readonly programId: SolanaAddress }
    readonly commitment: SolanaCommitment
    readonly minContextSlot?: bigint | undefined
  }) => Effect.Effect<SolanaTokenAccounts, SolanaRpcError>
  /**
   * `getSignatureStatuses` of at most 256 `signatures`, read from the blocks the node has processed, whatever their
   * commitment. Without `searchTransactionHistory` (sent as `false`), only the node's cache of recent slots is
   * searched: an older transaction is `null`.
   */
  readonly getSignatureStatuses: (options: {
    readonly signatures: ReadonlyArray<SolanaTransactionHash>
    readonly searchTransactionHistory?: boolean | undefined
  }) => Effect.Effect<SolanaSignatureStatuses, SolanaRpcError>
  /**
   * `getAccountInfo`: the account at `address` with its data in `encoding`. `minContextSlot` works as in
   * {@link SolanaSignaturesQuery}.
   */
  readonly getAccountInfo: <Encoding extends SolanaAccountEncoding>(options: {
    readonly address: SolanaAddress
    readonly commitment: SolanaCommitment
    readonly encoding: Encoding
    readonly minContextSlot?: bigint | undefined
  }) => Effect.Effect<SolanaAccountInfo<Encoding>, SolanaRpcError>
  /** `getBalance` at `finalized` commitment. */
  readonly getBalance: (options: {
    readonly address: SolanaAddress
  }) => Effect.Effect<SolanaBalance, SolanaRpcError>
  /** `getSignaturesForAddress`, one page. */
  readonly getSignaturesForAddress: (
    query: SolanaSignaturesQuery
  ) => Effect.Effect<ReadonlyArray<SolanaSignatureInfo>, SolanaRpcError>
  /**
   * `getTransaction` in `encoding`, `base64` by default, for legacy, version 0 and version 1 transactions. A
   * transaction the endpoint lacks fails `Pruned`.
   */
  readonly getTransaction: {
    (
      options: SolanaTransactionQuery & { readonly encoding?: "base64" | undefined }
    ): Effect.Effect<SolanaTransactionInfo, SolanaRpcError>
    <Encoding extends SolanaTransactionEncoding>(
      options: SolanaTransactionQuery & { readonly encoding: Encoding }
    ): Effect.Effect<SolanaTransactionInfo<Encoding>, SolanaRpcError>
  }
  /** `getLatestBlockhash` */
  readonly getLatestBlockhash: (options: {
    readonly commitment: SolanaCommitment
  }) => Effect.Effect<SolanaLatestBlockhash, SolanaRpcError>
  /**
   * `simulateTransaction` of a base64 wire `transaction`, run against the bank at `commitment` without being sent. A
   * transaction that would fail is a success whose `err` says why. `sigVerify` checks the signatures, and
   * `replaceRecentBlockhash` swaps the blockhash for the latest one, which unsigned transactions need: the node
   * refuses both together.
   */
  readonly simulateTransaction: (options: {
    readonly transaction: string
    readonly commitment: SolanaCommitment
    readonly sigVerify?: boolean | undefined
    readonly replaceRecentBlockhash?: boolean | undefined
  }) => Effect.Effect<SolanaSimulation, SolanaRpcError>
  /**
   * `getRecentPrioritizationFees` over the node's cache of recent slots (up to 150) for the transactions locking every
   * one of `addresses` as writable, at most 128 of them. Without `addresses`, any transaction counts.
   */
  readonly getRecentPrioritizationFees: (options: {
    readonly addresses: ReadonlyArray<SolanaAddress>
  }) => Effect.Effect<ReadonlyArray<SolanaPrioritizationFee>, SolanaRpcError>
  /**
   * `sendTransaction`: submits a signed base64 wire `transaction` and returns its first signature. The node simulates
   * it first at `preflightCommitment` (`finalized` by default) unless `skipPreflight`, then forwards it to the leader
   * and rebroadcasts it `maxRetries` times, or until its blockhash expires when left out. A retry or a fallback sends
   * the same bytes, so it never creates a second transaction, but a node that has processed them refuses the second
   * copy. A refusal (a failed preflight, `BlockhashNotFound`, `AlreadyProcessed`...) is `Rejected`, with the node's
   * message in `cause`.
   */
  readonly sendTransaction: (options: {
    readonly transaction: string
    readonly skipPreflight?: boolean | undefined
    readonly preflightCommitment?: SolanaCommitment | undefined
    readonly maxRetries?: number | undefined
  }) => Effect.Effect<SolanaTransactionHash, SolanaRpcError>
}>()("@effect-blockchain/solana/SolanaRpc") {}

// JSON-RPC codes from @solana/errors, any other code is `Rejected`
const codes: ReadonlyMap<number, JsonRpc.CodeReason> = new Map([
  [429, "Unavailable"],
  [SOLANA_ERROR__JSON_RPC__INTERNAL_ERROR, "Unavailable"],
  [SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY, "Unavailable"],
  [SOLANA_ERROR__JSON_RPC__SERVER_ERROR_LONG_TERM_STORAGE_UNREACHABLE, "Unavailable"],
  [SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED, "Lagging"],
  [SOLANA_ERROR__JSON_RPC__SERVER_ERROR_BLOCK_NOT_AVAILABLE, "Lagging"],
  [SOLANA_ERROR__JSON_RPC__SERVER_ERROR_BLOCK_STATUS_NOT_AVAILABLE_YET, "Lagging"],
  [SOLANA_ERROR__JSON_RPC__SERVER_ERROR_BLOCK_CLEANED_UP, "Pruned"],
  [SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SLOT_SKIPPED, "Pruned"],
  [SOLANA_ERROR__JSON_RPC__SERVER_ERROR_LONG_TERM_STORAGE_SLOT_SKIPPED, "Pruned"],
  [SOLANA_ERROR__JSON_RPC__SERVER_ERROR_TRANSACTION_HISTORY_NOT_AVAILABLE, "Pruned"],
  [SOLANA_ERROR__JSON_RPC__SERVER_ERROR_KEY_EXCLUDED_FROM_SECONDARY_INDEX, "Pruned"]
])

/**
 * Builds a {@link SolanaRpc} over `endpoints`, tried in order, sending requests with the provided `HttpClient`
 * (e.g. `FetchHttpClient.layer`). `timeout` (default 30 seconds) bounds each attempt, `retries` (default 3) and
 * `retryDelay` (default 500 millis) set the backoff before falling back: see {@link JsonRpc.Unavailable}.
 * `genesisHash` replaces the genesis hash of `network`, for a local validator or a private cluster, which have their
 * own.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer = (options: {
  readonly network: SolanaNetwork
  readonly genesisHash?: SolanaGenesisHash | undefined
  readonly endpoints: Arr.NonEmptyReadonlyArray<SolanaRpcEndpoint>
  readonly timeout?: Duration.Input | undefined
  readonly retries?: number | undefined
  readonly retryDelay?: Duration.Input | undefined
}): Layer.Layer<SolanaRpc, never, HttpClient.HttpClient> =>
  Layer.effect(
    SolanaRpc,
    Effect.gen(function*() {
      const { network } = options
      const expectedGenesisHash = options.genesisHash ?? toGenesisHash(network)
      const rpc = yield* JsonRpc.make({
        spanPrefix: "SolanaRpc",
        network,
        endpoints: options.endpoints,
        timeout: options.timeout,
        retries: options.retries,
        retryDelay: options.retryDelay,
        codes,
        parseBody: BigIntJson.parse,
        checkNetwork: (send, endpoint) =>
          send(RpcMethods.getGenesisHash, []).pipe(
            Effect.flatMap((genesisHash) =>
              genesisHash === expectedGenesisHash
                ? Effect.succeed(expectedGenesisHash)
                : Effect.fail(
                  new SolanaRpcError({
                    reason: new JsonRpc.WrongNetwork({ expected: expectedGenesisHash, actual: genesisHash }),
                    method: RpcMethods.getGenesisHash.name,
                    endpoint,
                    cause: new Error(`expected genesis hash ${expectedGenesisHash} for ${network}, got ${genesisHash}`)
                  })
                )
            )
          ),
        makeError: (fields: JsonRpc.ErrorFields) => new SolanaRpcError(fields)
      })
      type Endpoint = JsonRpc.Endpoint<SolanaGenesisHash, SolanaRpcError>

      const getTransactionOn = (
        endpoint: Endpoint,
        { commitment, encoding, signature }: SolanaTransactionQuery & { readonly encoding: SolanaTransactionEncoding }
      ) =>
        rpc.call(endpoint, RpcMethods.getTransaction(encoding), [signature, {
          commitment,
          encoding,
          maxSupportedTransactionVersion: RpcMethods.maxSupportedTransactionVersion
        }]).pipe(
          Effect.flatMap((tx) =>
            tx === null
              ? Effect.fail(
                rpc.fail(
                  endpoint,
                  RpcMethods.getTransaction.name,
                  new JsonRpc.Pruned(),
                  new Error(`transaction ${signature} not found`)
                )
              )
              : Effect.succeed(tx)
          )
        )
      function getTransaction(
        options: SolanaTransactionQuery & { readonly encoding?: "base64" | undefined }
      ): Effect.Effect<SolanaTransactionInfo, SolanaRpcError>
      function getTransaction<Encoding extends SolanaTransactionEncoding>(
        options: SolanaTransactionQuery & { readonly encoding: Encoding }
      ): Effect.Effect<SolanaTransactionInfo<Encoding>, SolanaRpcError>
      function getTransaction(
        { encoding = "base64", ...options }: SolanaTransactionQuery & {
          readonly encoding?: SolanaTransactionEncoding | undefined
        }
      ): Effect.Effect<SolanaTransactionInfo<SolanaTransactionEncoding>, SolanaRpcError> {
        return rpc.withFallback((endpoint) => getTransactionOn(endpoint, { ...options, encoding }))
      }

      function getAccountInfo<Encoding extends SolanaAccountEncoding>(options: {
        readonly address: SolanaAddress
        readonly commitment: SolanaCommitment
        readonly encoding: Encoding
        readonly minContextSlot?: bigint | undefined
      }): Effect.Effect<SolanaAccountInfo<Encoding>, SolanaRpcError>
      function getAccountInfo(
        { address, ...config }: {
          readonly address: SolanaAddress
          readonly commitment: SolanaCommitment
          readonly encoding: SolanaAccountEncoding
          readonly minContextSlot?: bigint | undefined
        }
      ): Effect.Effect<SolanaAccountInfo, SolanaRpcError> {
        return rpc.withFallback((endpoint) =>
          rpc.call(endpoint, RpcMethods.getAccountInfo(config.encoding), [address, config]).pipe(
            Effect.map(({ context, value }) => ({ slot: context.slot, value }))
          )
        )
      }

      return SolanaRpc.of({
        network,
        getGenesisHash: rpc.withFallback(rpc.checkNetwork),
        getSlot: ({ commitment }) =>
          rpc.withFallback((endpoint) => rpc.call(endpoint, RpcMethods.getSlot, [{ commitment }])),
        getBlockHeight: ({ commitment }) =>
          rpc.withFallback((endpoint) => rpc.call(endpoint, RpcMethods.getBlockHeight, [{ commitment }])),
        getEpochInfo: ({ commitment }) =>
          rpc.withFallback((endpoint) => rpc.call(endpoint, RpcMethods.getEpochInfo, [{ commitment }])),
        getBlockTime: ({ slot }) => rpc.withFallback((endpoint) => rpc.call(endpoint, RpcMethods.getBlockTime, [slot])),
        getBlocksWithLimit: ({ commitment, limit, startSlot }) =>
          limit > RpcMethods.maxBlocksLimit
            ? Effect.fail(
              new SolanaRpcError({
                reason: new JsonRpc.Rejected(),
                method: RpcMethods.getBlocksWithLimit.name,
                endpoint: "none",
                cause: new Error(`limit ${limit} is above the maximum of ${RpcMethods.maxBlocksLimit}`)
              })
            )
            : rpc.withFallback((endpoint) =>
              rpc.call(endpoint, RpcMethods.getBlocksWithLimit, [startSlot, limit, { commitment }])
            ),
        getTokenAccountsByOwner: ({ filter, owner, ...config }) =>
          rpc.withFallback((endpoint) =>
            rpc.call(endpoint, RpcMethods.getTokenAccountsByOwner, [owner, filter, {
              ...config,
              encoding: "base64",
              dataSlice: { offset: 0, length: 0 }
            }]).pipe(Effect.map(({ context, value }) => ({ slot: context.slot, value })))
          ),
        // Agave refuses a config without `searchTransactionHistory`
        getSignatureStatuses: ({ searchTransactionHistory = false, signatures }) =>
          rpc.withFallback((endpoint) =>
            rpc.call(endpoint, RpcMethods.getSignatureStatuses, [signatures, { searchTransactionHistory }]).pipe(
              Effect.map(({ context, value }) => ({ slot: context.slot, value }))
            )
          ),
        getAccountInfo,
        getBalance: ({ address }) =>
          rpc.withFallback((endpoint) =>
            rpc.call(endpoint, RpcMethods.getBalance, [address, { commitment: "finalized" }]).pipe(
              Effect.map(({ context, value }) => ({ slot: context.slot, value }))
            )
          ),
        getSignaturesForAddress: ({ address, ...config }) =>
          rpc.withFallback((endpoint) => rpc.call(endpoint, RpcMethods.getSignaturesForAddress, [address, config])),
        getTransaction,
        getLatestBlockhash: ({ commitment }) =>
          rpc.withFallback((endpoint) =>
            rpc.call(endpoint, RpcMethods.getLatestBlockhash, [{ commitment }]).pipe(
              Effect.map(({ context, value }) => ({ slot: context.slot, ...value }))
            )
          ),
        simulateTransaction: ({ transaction, ...config }) =>
          rpc.withFallback((endpoint) =>
            rpc.call(endpoint, RpcMethods.simulateTransaction, [transaction, { encoding: "base64", ...config }]).pipe(
              Effect.map(({ context, value }) => ({ slot: context.slot, ...value }))
            )
          ),
        getRecentPrioritizationFees: ({ addresses }) =>
          rpc.withFallback((endpoint) => rpc.call(endpoint, RpcMethods.getRecentPrioritizationFees, [addresses])),
        sendTransaction: ({ transaction, ...config }) =>
          rpc.withFallback((endpoint) =>
            rpc.call(endpoint, RpcMethods.sendTransaction, [transaction, { encoding: "base64", ...config }])
          )
      })
    })
  )

/**
 * Builds a {@link SolanaRpc} like {@link layer}, reading the options from `Config`. Endpoint URLs stay `Redacted`.
 *
 * @example
 * ```ts
 * import * as SolanaRpc from "@effect-blockchain/solana/SolanaRpc"
 * import * as Config from "effect/Config"
 *
 * const RpcLive = SolanaRpc.layerConfig({
 *   network: Config.succeed("Solana"),
 *   endpoints: Config.all([Config.all({ name: Config.succeed("main"), url: Config.Redacted("SOLANA_RPC_URL") })])
 * })
 * ```
 *
 * @since 0.1.0
 * @category layers
 */
export const layerConfig = (
  options: Config.Wrap<Parameters<typeof layer>[0]>
): Layer.Layer<SolanaRpc, Config.ConfigError, HttpClient.HttpClient> =>
  Layer.unwrap(Effect.map(Config.unwrap(options), layer))
