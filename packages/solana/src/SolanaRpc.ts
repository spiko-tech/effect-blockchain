/**
 * Typed, read-only Solana JSON-RPC methods over an ordered list of endpoints with fallback.
 *
 * A call starts at the first endpoint and moves to the next one on failure, except on `WrongNetwork`. Each endpoint
 * is checked once to serve the configured network (`getGenesisHash`). Every method is a read, so retries and fallback
 * are safe. Methods are named after the JSON-RPC method. Every JSON integer in a reply is read as an exact `bigint`,
 * so lamport amounts above 2^53 are never rounded.
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
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
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
import * as Option from "effect/Option"
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
 * A failed call: its `reason` (a {@link JsonRpc.Reason}, matched with `Effect.catchReason`), the JSON-RPC error code or
 * HTTP status as `code`, and a `cause` without the endpoint URL. After several endpoints, the error is the last one
 * and `cause` is an `AggregateError` of each endpoint's error, in order.
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
 * `getTransactionDecoder`) and for storing the exact bytes. `json` splits it into signatures, account keys and compiled
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
export interface SolanaCompiledInstruction {
  readonly programIdIndex: number
  readonly accounts: ReadonlyArray<number>
  readonly data: string
}

/**
 * A `json` transaction. `addressTableLookups` is absent from legacy transactions.
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
 * The status meta of a transaction, reduced to its outcome and lamport balances. `err` is the raw transaction error as
 * JSON (integers as decimal strings), `null` when it succeeded. `preBalances` and `postBalances` follow the account
 * keys, then `loadedAddresses` (absent from transactions older than versioned transactions).
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
  /** `getBalance` at `finalized` commitment. */
  readonly getBalance: (options: {
    readonly address: SolanaAddress
  }) => Effect.Effect<SolanaBalance, SolanaRpcError>
  /** `getSignaturesForAddress`, one page. */
  readonly getSignaturesForAddress: (
    query: SolanaSignaturesQuery
  ) => Effect.Effect<ReadonlyArray<SolanaSignatureInfo>, SolanaRpcError>
  /**
   * `getTransaction` in `encoding`, `base64` by default, versioned transactions included. A transaction the endpoint
   * lacks fails `Pruned`.
   */
  readonly getTransaction: {
    (
      options: SolanaTransactionQuery & { readonly encoding?: "base64" | undefined }
    ): Effect.Effect<SolanaTransactionInfo, SolanaRpcError>
    <Encoding extends SolanaTransactionEncoding>(
      options: SolanaTransactionQuery & { readonly encoding: Encoding }
    ): Effect.Effect<SolanaTransactionInfo<Encoding>, SolanaRpcError>
  }
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
 *
 * @since 0.1.0
 * @category layers
 */
export const layer = (options: {
  readonly network: SolanaNetwork
  readonly endpoints: Arr.NonEmptyReadonlyArray<SolanaRpcEndpoint>
  readonly timeout?: Duration.Input | undefined
  readonly retries?: number | undefined
  readonly retryDelay?: Duration.Input | undefined
}): Layer.Layer<SolanaRpc, never, HttpClient.HttpClient> =>
  Layer.effect(
    SolanaRpc,
    Effect.gen(function*() {
      const { network } = options
      const expectedGenesisHash = toGenesisHash(network)
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
          maxSupportedTransactionVersion: 0
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

      return SolanaRpc.of({
        network,
        getGenesisHash: rpc.withFallback(rpc.checkNetwork),
        getSlot: ({ commitment }) =>
          rpc.withFallback((endpoint) => rpc.call(endpoint, RpcMethods.getSlot, [{ commitment }])),
        getBalance: ({ address }) =>
          rpc.withFallback((endpoint) =>
            rpc.call(endpoint, RpcMethods.getBalance, [address, { commitment: "finalized" }]).pipe(
              Effect.map(({ context, value }) => ({ slot: context.slot, value }))
            )
          ),
        getSignaturesForAddress: ({ address, ...config }) =>
          rpc.withFallback((endpoint) => rpc.call(endpoint, RpcMethods.getSignaturesForAddress, [address, config])),
        getTransaction
      })
    })
  )

/**
 * The lamports of `address` before and after `transaction`, `Option.none()` when the address is not one of its accounts
 * or the node has no meta. An account's index runs over the static account keys, then the addresses loaded from lookup
 * tables, writable then readonly (see https://solana.com/docs/advanced/versions).
 *
 * @since 0.2.0
 * @category balances
 */
export const balanceChange = <Encoding extends SolanaTransactionEncoding>(
  transaction: SolanaTransactionInfo<Encoding>,
  address: SolanaAddress
): Option.Option<{ readonly pre: bigint; readonly post: bigint }> => {
  const { meta } = transaction
  if (meta === null) return Option.none()
  const encoded: SolanaEncodedTransaction[SolanaTransactionEncoding] = transaction.transaction
  const staticKeys = typeof encoded === "string"
    ? getCompiledTransactionMessageDecoder().decode(
      getTransactionDecoder().decode(getBase64Encoder().encode(encoded)).messageBytes
    ).staticAccounts
    : encoded.message.accountKeys
  const keys = [...staticKeys, ...meta.loadedAddresses?.writable ?? [], ...meta.loadedAddresses?.readonly ?? []]
  const index = keys.indexOf(address)
  const pre = meta.preBalances[index]
  const post = meta.postBalances[index]
  return pre === undefined || post === undefined ? Option.none() : Option.some({ pre, post })
}

/**
 * Builds an {@link SolanaRpc} like {@link layer}, reading the options from `Config`. Endpoint URLs stay `Redacted`.
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
