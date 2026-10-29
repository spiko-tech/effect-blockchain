/**
 * Typed, read-only standard Solana JSON-RPC methods, served by an ordered list of endpoints with fallback.
 *
 * Every call starts at the first endpoint. An endpoint failure that another endpoint could answer (see
 * {@link SolanaRpcError}) moves to the next endpoint, any other failure stops at once. Before its first call, each
 * endpoint is checked to serve the configured network (`getGenesisHash`), once.
 *
 * Requests go through `@solana/kit`'s HTTP transport, which reads every JSON integer as an exact `bigint`: lamport
 * amounts above 2^53 are never rounded.
 *
 * Every method is a read and safe to repeat, which is what makes the fallback and the retries sound. A future write
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
import {
  createDefaultRpcTransport,
  getSolanaErrorFromJsonRpcError,
  isSolanaError,
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
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_TRANSACTION_HISTORY_NOT_AVAILABLE,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR
} from "@solana/kit"
import type * as Arr from "effect/Array"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Result from "effect/Result"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as SynchronizedRef from "effect/SynchronizedRef"
import { redactRpcUrl } from "./internal/redactRpcUrl.ts"
import * as RpcMethods from "./internal/rpcMethods.ts"
import type { SolanaAddress } from "./SolanaAddress.ts"
import type { SolanaNetwork } from "./SolanaNetwork.ts"
import type { SolanaTransactionHash } from "./SolanaTransactionHash.ts"

/**
 * A JSON-RPC endpoint. The `name` is shown in errors and spans, the `url` is never logged.
 *
 * @since 0.1.0
 * @category Models
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
 * | `Unavailable` | transport error, timeout, any HTTP error status, node unhealthy or internal error, after retries | yes |
 * | `InvalidResponse` | the result fails its schema | yes |
 * | `Lagging` | the endpoint has not reached `minContextSlot`, or the block is not available yet | yes |
 * | `Pruned` | the endpoint lacks the requested history, e.g. `getTransaction` returns `null` | yes |
 * | `Rejected` | any other JSON-RPC error: every endpoint would answer the same | no |
 * | `WrongNetwork` | the endpoint's genesis hash is not the configured network's | no |
 *
 * @since 0.1.0
 * @category Models
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
 * @category Models
 */
export type SolanaRpcErrorReason = typeof SolanaRpcErrorReason.Type

/**
 * A failed call. `code` is the JSON-RPC error code or the HTTP status when there is one, and `cause` never contains
 * the endpoint URL. When several endpoints were tried, the error is the last one and its `cause` is an
 * `AggregateError` of every endpoint's error, in order.
 *
 * @since 0.1.0
 * @category Errors
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
 * @category Models
 */
export type SolanaCommitment = "confirmed" | "finalized"

/**
 * One `getSignaturesForAddress` page: signatures touching `address`, newest first, older than `before` and newer than
 * `until` when given, at most `limit` (the node's default and maximum is 1000).
 *
 * @since 0.1.0
 * @category Models
 */
export interface SolanaSignaturesQuery {
  readonly address: SolanaAddress
  readonly before?: SolanaTransactionHash | undefined
  readonly until?: SolanaTransactionHash | undefined
  readonly limit?: number | undefined
  readonly commitment: SolanaCommitment
  /** Only answered by an endpoint that has reached this slot, `Lagging` otherwise. */
  readonly minContextSlot?: bigint | undefined
}

/**
 * A `getSignaturesForAddress` entry. `blockTime` is a Unix timestamp in seconds, `null` when the node does not know
 * it. `err` is the raw transaction error as JSON (integers as decimal strings), `null` when the transaction succeeded.
 *
 * @since 0.1.0
 * @category Models
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
 * @category Models
 */
export interface SolanaTransactionInfo {
  readonly slot: bigint
  readonly blockTime: bigint | null
  readonly transaction: string
  readonly meta: Schema.Json
}

/**
 * @since 0.1.0
 * @category Services
 */
export class SolanaRpc extends Context.Service<SolanaRpc, {
  readonly network: SolanaNetwork
  /** `getGenesisHash`, verified against `network` once per endpoint then served from that check. */
  readonly getGenesisHash: Effect.Effect<string, SolanaRpcError>
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

// `--expected-genesis-hash` of each cluster, https://docs.anza.xyz/clusters/available
const genesisHashes: { readonly [N in SolanaNetwork]: string } = {
  Solana: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  SolanaDevnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  SolanaTestnet: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY"
}

const fallbackReasons: ReadonlySet<SolanaRpcErrorReason> = new Set([
  "Unavailable",
  "InvalidResponse",
  "Lagging",
  "Pruned"
])

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

// a 4xx other than 408 / 429 (e.g. a bad API key) will not change on retry, but the next endpoint may accept it
const isRetryable = (error: SolanaRpcError) =>
  error.reason === "Unavailable" &&
  !(error.code !== undefined && error.code >= 400 && error.code < 500 && error.code !== 408 && error.code !== 429)

// `Retry-After` in seconds or as an HTTP date
const retryAfter = (error: SolanaRpcError, now: number): Duration.Duration => {
  if (!isSolanaError(error.cause, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)) return Duration.zero
  const header = error.cause.context.headers.get("retry-after")
  if (header === null) return Duration.zero
  const seconds = Number(header)
  const millis = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now
  return millis > 0 ? Duration.millis(millis) : Duration.zero
}

type NetworkCheck = "Unchecked" | "Checked" | SolanaRpcError

/**
 * Builds a {@link SolanaRpc} over `endpoints`, tried in order.
 *
 * - `timeout` bounds each attempt and aborts its request, default 30 seconds.
 * - `retries` is the number of retries per endpoint before falling back, default 3. `Unavailable` failures are
 *   retried, except HTTP 4xx statuses other than 408 and 429, with an exponential backoff from `retryDelay`
 *   (default 500 millis) with jitter, waiting at least `Retry-After` when the endpoint sends it.
 *
 * Requests use the global `fetch`.
 *
 * @since 0.1.0
 * @category Layers
 */
export const layer = (options: {
  readonly network: SolanaNetwork
  readonly endpoints: Arr.NonEmptyReadonlyArray<SolanaRpcEndpoint>
  readonly timeout?: Duration.Input | undefined
  readonly retries?: number | undefined
  readonly retryDelay?: Duration.Input | undefined
}): Layer.Layer<SolanaRpc> =>
  Layer.effect(
    SolanaRpc,
    Effect.gen(function*() {
      const { network } = options
      const expectedGenesisHash = genesisHashes[network]
      const timeout = Duration.fromInputUnsafe(options.timeout ?? Duration.seconds(30))
      const retry = {
        times: options.retries ?? 3,
        while: isRetryable,
        schedule: Schedule.exponential(options.retryDelay ?? Duration.millis(500)).pipe(
          Schedule.jittered,
          Schedule.setInputType<SolanaRpcError>(),
          Schedule.modifyDelay(({ duration, input, now }) =>
            Effect.succeed(Duration.max(duration, retryAfter(input, now)))
          )
        )
      }

      const endpoints = yield* Effect.forEach(options.endpoints, (endpoint) =>
        Effect.gen(function*() {
          const url = Redacted.value(endpoint.url)
          return {
            name: endpoint.name,
            url,
            transport: createDefaultRpcTransport({ url }),
            networkCheck: yield* SynchronizedRef.make<NetworkCheck>("Unchecked")
          }
        }))
      type Endpoint = typeof endpoints[number]

      const fail = (endpoint: Endpoint, method: string, reason: SolanaRpcErrorReason, cause: Error) =>
        new SolanaRpcError({ reason, method, endpoint: endpoint.name, cause })

      const send = <Params, A>(endpoint: Endpoint, method: RpcMethods.RpcMethod<Params, A>, params: Params) =>
        Effect.gen(function*() {
          const encoded = yield* Schema.encodeEffect(method.params)(params).pipe(
            Effect.mapError((cause) => fail(endpoint, method.name, "Rejected", cause))
          )
          // one request per HTTP call: the id is never matched
          const payload = { jsonrpc: "2.0", id: 0, method: method.name, params: encoded }
          const response = yield* Effect.tryPromise({
            try: (signal) => endpoint.transport({ payload, signal }),
            catch: (error) =>
              new SolanaRpcError({
                reason: "Unavailable",
                code: isSolanaError(error, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)
                  ? error.context.statusCode
                  : undefined,
                method: method.name,
                endpoint: endpoint.name,
                cause: redactRpcUrl(error, endpoint.url)
              })
          }).pipe(
            Effect.timeoutOrElse({
              duration: timeout,
              orElse: () =>
                Effect.fail(
                  fail(endpoint, method.name, "Unavailable", new Error(`timed out after ${Duration.format(timeout)}`))
                )
            }),
            Effect.flatMap((response) =>
              Option.match(Schema.decodeUnknownOption(RpcMethods.JsonRpcError)(response), {
                onNone: () => Effect.succeed(response),
                onSome: ({ error }) => {
                  const code = Number(error.code)
                  return Effect.fail(
                    new SolanaRpcError({
                      reason: codeReasons.get(code) ?? "Rejected",
                      code,
                      method: method.name,
                      endpoint: endpoint.name,
                      cause: getSolanaErrorFromJsonRpcError(error)
                    })
                  )
                }
              })
            ),
            Effect.retry(retry)
          )
          const decoded = yield* Schema.decodeUnknownEffect(Schema.Struct({ result: method.result }))(response).pipe(
            Effect.mapError((cause) => fail(endpoint, method.name, "InvalidResponse", cause))
          )
          return decoded.result
        }).pipe(
          Effect.withSpan(`SolanaRpc.${method.name}`, {
            attributes: { network, endpoint: endpoint.name, method: method.name }
          })
        )

      // a mismatch is kept, a failed check is not: the next call checks again
      const checkNetwork = (endpoint: Endpoint) =>
        SynchronizedRef.modifyEffect(endpoint.networkCheck, (state) =>
          state !== "Unchecked"
            ? Effect.succeed([state, state] as const)
            : send(endpoint, RpcMethods.getGenesisHash, []).pipe(
              Effect.map((genesisHash): NetworkCheck =>
                genesisHash === expectedGenesisHash ?
                  "Checked" :
                  fail(
                    endpoint,
                    RpcMethods.getGenesisHash.name,
                    "WrongNetwork",
                    new Error(`expected genesis hash ${expectedGenesisHash} for ${network}, got ${genesisHash}`)
                  )
              ),
              Effect.map((checked) => [checked, checked] as const)
            )).pipe(Effect.flatMap((state) => state instanceof SolanaRpcError ? Effect.fail(state) : Effect.void))

      const call = <Params, A>(endpoint: Endpoint, method: RpcMethods.RpcMethod<Params, A>, params: Params) =>
        checkNetwork(endpoint).pipe(Effect.andThen(send(endpoint, method, params)))

      const withFallback = Effect.fnUntraced(function*<A>(
        f: (endpoint: Endpoint) => Effect.Effect<A, SolanaRpcError>
      ): Effect.fn.Return<A, SolanaRpcError> {
        const errors: Array<SolanaRpcError> = []
        for (const endpoint of endpoints) {
          const result = yield* Effect.result(f(endpoint))
          if (Result.isSuccess(result)) return result.success
          errors.push(result.failure)
          if (!fallbackReasons.has(result.failure.reason)) break
        }
        const last = errors[errors.length - 1]
        if (errors.length === 1) return yield* last
        return yield* new SolanaRpcError({
          reason: last.reason,
          method: last.method,
          endpoint: last.endpoint,
          code: last.code,
          cause: new AggregateError(errors, `${errors.length} endpoints failed`)
        })
      })

      const getTransactionOn = (
        endpoint: Endpoint,
        { commitment, signature }: { readonly signature: SolanaTransactionHash; readonly commitment: SolanaCommitment }
      ) =>
        call(endpoint, RpcMethods.getTransaction, [signature, {
          commitment,
          encoding: "base64",
          maxSupportedTransactionVersion: 0
        }]).pipe(
          Effect.flatMap((tx) =>
            tx === null
              ? Effect.fail(
                fail(
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
        getGenesisHash: withFallback((endpoint) => checkNetwork(endpoint).pipe(Effect.as(expectedGenesisHash))),
        getSlot: ({ commitment }) => withFallback((endpoint) => call(endpoint, RpcMethods.getSlot, [{ commitment }])),
        getSignaturesForAddress: ({ address, ...config }) =>
          withFallback((endpoint) => call(endpoint, RpcMethods.getSignaturesForAddress, [address, config])),
        getTransaction: (options) => withFallback((endpoint) => getTransactionOn(endpoint, options))
      })
    })
  )
