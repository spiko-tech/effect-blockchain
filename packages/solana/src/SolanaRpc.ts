/**
 * Typed, read-only standard Solana JSON-RPC methods, served by an ordered list of endpoints with fallback.
 *
 * Every call starts at the first endpoint. An endpoint failure (see {@link SolanaRpcError}) moves to the next
 * endpoint, except `WrongNetwork`, which stops at once. Before its first call, each
 * endpoint is checked to serve the configured network (`getGenesisHash`), once.
 *
 * Requests go through the provided `HttpClient`. Every JSON integer in a reply is read as an exact `bigint`: lamport
 * amounts above 2^53 are never rounded.
 *
 * Every method is a read and safe to repeat, which is what makes the fallback and the HTTP retries sound. A future write
 * method (e.g. `sendTransaction`) must take a transaction signed outside this module, resend the same signed bytes on
 * fallback, never retry blindly after an unclear failure and confirm the outcome by signature.
 *
 * Adding a method takes three steps:
 * 1. define it once in `internal/rpcMethods.ts`: its JSON-RPC name, a params codec and a result codec,
 * 2. add one line to the {@link SolanaRpc} service and its layer, calling it through the shared `call`, which does the
 *    network check, the request, the retries, the error classification, the decoding and the span,
 * 3. add one test decoding a fake response.
 *
 * Methods are named after the JSON-RPC method.
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
 * Why a call failed:
 *
 * | reason | meaning | falls back to the next endpoint |
 * |---|---|---|
 * | `Unavailable` | transport error, any HTTP error status, node unhealthy or internal error after retries, or a timeout | yes |
 * | `InvalidResponse` | the reply is not JSON or fails its schema | yes |
 * | `Lagging` | the endpoint has not reached `minContextSlot` (only from providers that honour it), or the block is not available yet | yes |
 * | `Pruned` | the endpoint lacks the requested history, e.g. `getTransaction` returns `null` | yes |
 * | `Rejected` | any other JSON-RPC error: not retried, but another provider may answer (e.g. a lower block range limit) | yes |
 * | `WrongNetwork` | the endpoint's genesis hash is not the configured network's | no |
 *
 * @since 0.1.0
 * @category models
 */
export const SolanaRpcErrorReason = Schema.Literals([
  "Unavailable",
  "InvalidResponse",
  "Lagging",
  "Pruned",
  "Rejected",
  "WrongNetwork"
])

/**
 * @since 0.1.0
 * @category models
 */
export type SolanaRpcErrorReason = typeof SolanaRpcErrorReason.Type

/**
 * A failed call. `code` is the JSON-RPC error code or the HTTP status when there is one, and `cause` never contains
 * the endpoint URL. When several endpoints were tried, the error is the last one and its `cause` is an
 * `AggregateError` of every endpoint's error, in order.
 *
 * @since 0.1.0
 * @category errors
 */
export class SolanaRpcError extends Schema.TaggedError<SolanaRpcError>()("SolanaRpcError", {
  reason: SolanaRpcErrorReason,
  method: Schema.String,
  endpoint: Schema.String,
  code: Schema.optional(Schema.Number),
  cause: Schema.Defect()
}) {
  /**
   * @since 0.1.0
   */
  override get message(): string {
    return `${this.method} failed on ${this.endpoint}: ${this.reason}${
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
   * An endpoint that honours it answers `Lagging` until it has reached this slot. Some providers ignore it (Alchemy, as
   * recorded on 2026-11-03) and answer from wherever they are, so a caller that needs the guarantee must check the head
   * itself, e.g. by comparing `getSlot` across endpoints.
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
 * A `getTransaction` result. `transaction` is the signed wire transaction, base64-encoded. `meta` is the raw status
 * meta (fee, balances, logs, inner instructions...) as JSON with every integer as a decimal string, so u64 values are
 * exact and the value can be stored as is. It is `null` when the node does not have it.
 *
 * @since 0.1.0
 * @category models
 */
export interface SolanaTransactionInfo {
  readonly slot: bigint
  readonly blockTime: bigint | null
  readonly transaction: string
  readonly meta: Schema.Json
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
  /** `getSignaturesForAddress`, one page. */
  readonly getSignaturesForAddress: (
    query: SolanaSignaturesQuery
  ) => Effect.Effect<ReadonlyArray<SolanaSignatureInfo>, SolanaRpcError>
  /** `getTransaction` in base64, versioned transactions included. A transaction the endpoint lacks fails `Pruned`. */
  readonly getTransaction: (options: {
    readonly signature: SolanaTransactionHash
    readonly commitment: SolanaCommitment
  }) => Effect.Effect<SolanaTransactionInfo, SolanaRpcError>
}>()("@effect-blockchain/solana/SolanaRpc") {}

// JSON-RPC codes from @solana/errors, any other code is `Rejected`
const codeReasons: ReadonlyMap<number, SolanaRpcErrorReason> = new Map([
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
 * (e.g. `FetchHttpClient.layer`).
 *
 * - `timeout` bounds each attempt, default 30 seconds. A timed-out attempt is not retried: the call moves to the next
 *   endpoint at once.
 * - `retries` is the number of retries per endpoint before falling back, default 3. Transport errors, HTTP
 *   408/429/500/502/503/504 and the `Unavailable` JSON-RPC codes (429, -32603, -32005, -32019) are retried with an
 *   exponential backoff from `retryDelay` (default 500 millis) with jitter, honoring `Retry-After`. Any other HTTP
 *   status (e.g. 403) is not retried and falls back at once.
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
        codes: codeReasons,
        parseBody: BigIntJson.parse,
        checkNetwork: (send, endpoint) =>
          send(RpcMethods.getGenesisHash, []).pipe(
            Effect.flatMap((genesisHash) =>
              genesisHash === expectedGenesisHash
                ? Effect.succeed(expectedGenesisHash)
                : Effect.fail(
                  new SolanaRpcError({
                    reason: "WrongNetwork",
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
        { commitment, signature }: { readonly signature: SolanaTransactionHash; readonly commitment: SolanaCommitment }
      ) =>
        rpc.call(endpoint, RpcMethods.getTransaction, [signature, {
          commitment,
          encoding: "base64",
          maxSupportedTransactionVersion: 0
        }]).pipe(
          Effect.flatMap((tx) =>
            tx === null
              ? Effect.fail(
                rpc.fail(
                  endpoint,
                  RpcMethods.getTransaction.name,
                  "Pruned",
                  new Error(`transaction ${signature} not found`)
                )
              )
              : Effect.succeed({
                slot: tx.slot,
                blockTime: tx.blockTime,
                transaction: tx.transaction[0],
                meta: tx.meta
              })
          )
        )

      return SolanaRpc.of({
        network,
        getGenesisHash: rpc.withFallback(rpc.checkNetwork),
        getSlot: ({ commitment }) =>
          rpc.withFallback((endpoint) => rpc.call(endpoint, RpcMethods.getSlot, [{ commitment }])),
        getSignaturesForAddress: ({ address, ...config }) =>
          rpc.withFallback((endpoint) => rpc.call(endpoint, RpcMethods.getSignaturesForAddress, [address, config])),
        getTransaction: (options) => rpc.withFallback((endpoint) => getTransactionOn(endpoint, options))
      })
    })
  )
