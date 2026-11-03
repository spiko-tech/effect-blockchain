/**
 * Typed, read-only standard EVM JSON-RPC methods, served by an ordered list of endpoints with fallback.
 *
 * Every call starts at the first endpoint. An endpoint failure that another endpoint could answer (see
 * {@link EvmRpcError}) moves to the next endpoint, any other failure stops at once. Before its first call, each
 * endpoint is checked to serve the configured network (`eth_chainId`), once.
 *
 * Every method is a read and safe to repeat, which is what makes the fallback and the HTTP retries sound. A future
 * write method (e.g. `eth_sendRawTransaction`) must take a transaction signed outside this module, resend the same
 * signed bytes on fallback, never retry blindly after an unclear failure and confirm the outcome by transaction hash.
 *
 * Adding a method takes three steps:
 * 1. define it once in `internal/rpcMethods.ts`: its JSON-RPC name, a params codec and a result codec,
 * 2. add one line to the {@link EvmRpc} service and its layer, calling it through the engine's `call`, which does the
 *    network check, the request, the error classification, the decoding and the span,
 * 3. add one test decoding a fake response.
 *
 * Methods are named after the JSON-RPC method without its namespace (`eth_getLogs` is `getLogs`).
 *
 * @since 0.1.0
 */
import * as JsonRpc from "@effect-blockchain/core/JsonRpc"
import * as Arr from "effect/Array"
import * as BigInt_ from "effect/BigInt"
import * as Context from "effect/Context"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import type * as HttpClient from "effect/http/HttpClient"
import * as Layer from "effect/Layer"
import * as Order from "effect/Order"
import type * as Redacted from "effect/Redacted"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import type { EvmAddress } from "./EvmAddress.ts"
import type { EvmHexData } from "./EvmHexData.ts"
import type { EvmLog } from "./EvmLog.ts"
import * as EvmNetwork from "./EvmNetwork.ts"
import * as RpcMethods from "./internal/rpcMethods.ts"

/**
 * A JSON-RPC endpoint. The `name` is shown in errors and spans, the `url` is never logged.
 *
 * @since 0.1.0
 * @category models
 */
export interface EvmRpcEndpoint {
  readonly name: string
  readonly url: Redacted.Redacted<string>
}

/**
 * Why a call failed:
 *
 * | reason | meaning | falls back to the next endpoint |
 * |---|---|---|
 * | `Unavailable` | transport, attempt timeout, HTTP error status, rate-limit or internal error codes, after the retries | yes |
 * | `InvalidResponse` | the reply is not JSON or fails its schema, or a log fails the `getLogs` checks | yes |
 * | `Lagging` | the endpoint's head is below the requested `toBlock` | yes |
 * | `Pruned` | the endpoint lacks the requested history (unused on EVM for now) | yes |
 * | `Rejected` | any other JSON-RPC error: every endpoint would answer the same | no |
 * | `WrongNetwork` | the endpoint's `eth_chainId` is not the configured network's | no |
 *
 * @since 0.1.0
 * @category models
 */
export const EvmRpcErrorReason = Schema.Literals([
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
export type EvmRpcErrorReason = typeof EvmRpcErrorReason.Type

/**
 * A failed call. `code` is the JSON-RPC error code or the HTTP status when there is one, and `cause` never contains
 * the endpoint URL. When several endpoints were tried, the error is the last one and its `cause` is an
 * `AggregateError` of every endpoint's error, in order.
 *
 * @since 0.1.0
 * @category errors
 */
export class EvmRpcError extends Schema.TaggedError<EvmRpcError>()("EvmRpcError", {
  reason: EvmRpcErrorReason,
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
 * An `eth_getLogs` filter over the inclusive block range `[fromBlock, toBlock]`.
 *
 * @since 0.1.0
 * @category models
 */
export interface EvmLogsFilter {
  readonly address: EvmAddress | ReadonlyArray<EvmAddress>
  readonly fromBlock: bigint
  readonly toBlock: bigint
  readonly topics?: ReadonlyArray<EvmHexData | ReadonlyArray<EvmHexData> | null> | undefined
}

/**
 * @since 0.1.0
 * @category services
 */
export class EvmRpc extends Context.Service<EvmRpc, {
  readonly network: EvmNetwork.EvmNetwork
  /** `eth_chainId`, verified against `network` once per endpoint then served from that check. */
  readonly chainId: Effect.Effect<EvmNetwork.EvmChainId, EvmRpcError>
  /** `eth_blockNumber` */
  readonly blockNumber: Effect.Effect<bigint, EvmRpcError>
  /**
   * `eth_getLogs`, only answered by an endpoint whose head has reached `toBlock`. Logs are returned in chain order:
   * sorted by block then log index. A removed, pending or out-of-filter log fails with `InvalidResponse`. An empty
   * range returns `[]`.
   */
  readonly getLogs: (filter: EvmLogsFilter) => Effect.Effect<ReadonlyArray<EvmLog>, EvmRpcError>
}>()("@effect-blockchain/evm/EvmRpc") {}

// the JSON-RPC codes viem 2.57.11 retries (`utils/buildRequest.ts`, `shouldRetry`): limit exceeded, internal error,
// QuickNode rate limit, unknown error and Alchemy's batch rate limit. The endpoint is struggling: retry then fall back
const codes: ReadonlyMap<number, JsonRpc.Reason> = new Map(
  [-32005, -32603, -32007, -1, 429].map((code) => [code, "Unavailable"])
)

const byBlockThenIndex = Order.combine(
  Order.mapInput(Order.BigInt, (log: EvmLog) => log.blockNumber),
  Order.mapInput(Order.Number, (log: EvmLog) => log.logIndex)
)

/**
 * Builds an {@link EvmRpc} over `endpoints`, tried in order, sending requests with the provided `HttpClient`
 * (e.g. `FetchHttpClient.layer`).
 *
 * - `timeout` bounds each attempt, default 30 seconds. A timed-out attempt is not retried: the call moves to the next
 *   endpoint at once.
 * - `retries` is the number of retries per endpoint before falling back, default 3. Transport errors, HTTP
 *   408/429/500/502/503/504 and the `Unavailable` JSON-RPC codes (-32005, -32603, -32007, -1, 429) are retried with an
 *   exponential backoff from `retryDelay` (default 500 millis) with jitter, honoring `Retry-After`. Any other HTTP
 *   status (e.g. 403) is not retried and falls back at once.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer = (options: {
  readonly network: EvmNetwork.EvmNetwork
  readonly endpoints: Arr.NonEmptyReadonlyArray<EvmRpcEndpoint>
  readonly timeout?: Duration.Input | undefined
  readonly retries?: number | undefined
  readonly retryDelay?: Duration.Input | undefined
}): Layer.Layer<EvmRpc, never, HttpClient.HttpClient> =>
  Layer.effect(
    EvmRpc,
    Effect.gen(function*() {
      const { network } = options
      const expectedChainId = EvmNetwork.toChainId(network)
      const rpc = yield* JsonRpc.make({
        spanPrefix: "EvmRpc",
        network,
        endpoints: options.endpoints,
        timeout: options.timeout,
        retries: options.retries,
        retryDelay: options.retryDelay,
        codes,
        checkNetwork: (send, endpoint) =>
          send(RpcMethods.chainId, []).pipe(
            Effect.flatMap((chainId) =>
              chainId === expectedChainId ?
                Effect.succeed(expectedChainId) :
                Effect.fail(
                  new EvmRpcError({
                    reason: "WrongNetwork",
                    method: RpcMethods.chainId.name,
                    endpoint,
                    cause: new Error(`expected chain ID ${expectedChainId} for ${network}, got ${chainId}`)
                  })
                )
            )
          ),
        makeError: (fields: JsonRpc.ErrorFields) => new EvmRpcError(fields)
      })
      type Endpoint = JsonRpc.Endpoint<EvmNetwork.EvmChainId, EvmRpcError>

      const blockNumberOn = (endpoint: Endpoint) =>
        rpc.call(endpoint, RpcMethods.blockNumber, []).pipe(
          Effect.tap((head) => Ref.update(endpoint.head, BigInt_.max(head)))
        )

      const getLogsOn = (endpoint: Endpoint, filter: EvmLogsFilter) =>
        Effect.gen(function*() {
          const method = RpcMethods.getLogs.name
          yield* rpc.guard(endpoint, method, filter.toBlock, blockNumberOn(endpoint))
          const addresses = new Set<string>(Arr.ensure(filter.address))
          const logs = yield* rpc.call(endpoint, RpcMethods.getLogs, [filter])
          const invalid = logs.find((log) =>
            log.blockNumber < filter.fromBlock || log.blockNumber > filter.toBlock ||
            !addresses.has(log.address)
          )
          if (invalid !== undefined) {
            return yield* rpc.fail(
              endpoint,
              method,
              "InvalidResponse",
              new Error(`log ${invalid.transactionHash}#${invalid.logIndex} is outside the filter`)
            )
          }
          return Arr.sort(logs.map(({ removed: _removed, ...log }) => log), byBlockThenIndex)
        })

      return EvmRpc.of({
        network,
        chainId: rpc.withFallback(rpc.checkNetwork),
        blockNumber: rpc.withFallback(blockNumberOn),
        getLogs: (filter) =>
          filter.fromBlock > filter.toBlock
            ? Effect.succeed([])
            : rpc.withFallback((endpoint) => getLogsOn(endpoint, filter))
      })
    })
  )
