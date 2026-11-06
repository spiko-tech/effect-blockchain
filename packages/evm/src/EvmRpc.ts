/**
 * Typed, read-only EVM JSON-RPC methods over an ordered list of endpoints with fallback.
 *
 * A call starts at the first endpoint and moves to the next one on failure, except on `WrongNetwork`. Each endpoint
 * is checked once to serve the configured network (`eth_chainId`). Every method is a read, so retries and fallback
 * are safe. Methods are named after the JSON-RPC method without its namespace (`eth_getLogs` is `getLogs`).
 *
 * @example
 * ```ts
 * import type { EvmLog } from "@effect-blockchain/evm/EvmLog"
 * import * as EvmRpc from "@effect-blockchain/evm/EvmRpc"
 * import * as Effect from "effect/Effect"
 *
 * // dates logs with one `eth_getBlockByNumber` per distinct block
 * const withTimestamps = (logs: ReadonlyArray<EvmLog>) =>
 *   Effect.gen(function*() {
 *     const rpc = yield* EvmRpc.EvmRpc
 *     const blocks = yield* Effect.forEach(
 *       new Set(logs.map((log) => log.blockNumber)),
 *       (blockNumber) => rpc.getBlockByNumber({ blockNumber }),
 *       { concurrency: 4 }
 *     )
 *     const timestamps = new Map(blocks.map((block) => [block.number, block.timestamp]))
 *     return logs.map((log) => ({ ...log, timestamp: timestamps.get(log.blockNumber) }))
 *   })
 * ```
 *
 * @since 0.1.0
 */
import * as JsonRpc from "@effect-blockchain/core/JsonRpc"
import * as Arr from "effect/Array"
import * as BigInt_ from "effect/BigInt"
import * as Config from "effect/Config"
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
import type { EvmBlock } from "./EvmBlock.ts"
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
 * A failed call: its `reason` (a {@link JsonRpc.Reason}, matched with `Effect.catchReason`), the JSON-RPC error code or
 * HTTP status as `code`, and a `cause` without the endpoint URL. After several endpoints, the error is the last one
 * and `cause` is an `AggregateError` of each endpoint's error, in order.
 *
 * On EVM, `Unavailable` includes the codes -32005, -32603, -32007, -1 and 429, `InvalidResponse` a log outside the
 * `getLogs` filter, and `Lagging` a head below the requested block.
 *
 * @since 0.1.0
 * @category errors
 */
export class EvmRpcError extends Schema.TaggedError<EvmRpcError>()("EvmRpcError", {
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
 * An `eth_getLogs` filter over the inclusive block range `[fromBlock, toBlock]`, matching the logs of any of
 * `addresses`. The addresses are always sent as the JSON-RPC `address` array.
 *
 * @since 0.1.0
 * @category models
 */
export interface EvmLogsFilter {
  readonly addresses: Arr.NonEmptyReadonlyArray<EvmAddress>
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
   * `eth_getBlockByNumber` without the transactions, only answered by an endpoint whose head has reached
   * `blockNumber`. A block unknown to an endpoint past it (`null`) fails with `Lagging`: every node keeps the headers
   * of its chain, so the reply came from a backend node behind the provider's head. A block whose `number` is not the
   * requested one fails with `InvalidResponse`.
   */
  readonly getBlockByNumber: (options: { readonly blockNumber: bigint }) => Effect.Effect<EvmBlock, EvmRpcError>
  /**
   * `eth_getLogs`, only answered by an endpoint whose head has reached `toBlock`. Logs are returned in chain order:
   * sorted by block then log index. A removed, pending or out-of-filter log fails with `InvalidResponse`. An empty
   * range returns `[]`.
   */
  readonly getLogs: (filter: EvmLogsFilter) => Effect.Effect<ReadonlyArray<EvmLog>, EvmRpcError>
}>()("@effect-blockchain/evm/EvmRpc") {}

// the JSON-RPC codes viem 2.57.11 retries (`utils/buildRequest.ts`, `shouldRetry`): limit exceeded, internal error,
// QuickNode rate limit, unknown error and Alchemy's batch rate limit. The endpoint is struggling: retry then fall back
const codes: ReadonlyMap<number, JsonRpc.CodeReason> = new Map(
  [-32005, -32603, -32007, -1, 429].map((code) => [code, "Unavailable"])
)

const byBlockThenIndex = Order.combine(
  Order.mapInput(Order.BigInt, (log: EvmLog) => log.blockNumber),
  Order.mapInput(Order.Number, (log: EvmLog) => log.logIndex)
)

/**
 * Builds an {@link EvmRpc} over `endpoints`, tried in order, sending requests with the provided `HttpClient`
 * (e.g. `FetchHttpClient.layer`). `timeout` (default 30 seconds) bounds each attempt, `retries` (default 3) and
 * `retryDelay` (default 500 millis) set the backoff before falling back: see {@link JsonRpc.Unavailable}.
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
                    reason: new JsonRpc.WrongNetwork({ expected: String(expectedChainId), actual: String(chainId) }),
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

      const getBlockByNumberOn = (endpoint: Endpoint, blockNumber: bigint) =>
        Effect.gen(function*() {
          const method = RpcMethods.getBlockByNumber.name
          yield* rpc.requireHead(endpoint, method, blockNumber, blockNumberOn(endpoint))
          const block = yield* rpc.call(endpoint, RpcMethods.getBlockByNumber, [blockNumber, false])
          if (block === null) {
            const head = yield* Ref.get(endpoint.head)
            return yield* rpc.fail(
              endpoint,
              method,
              new JsonRpc.Lagging({ head, toBlock: blockNumber }),
              new Error(`block ${blockNumber} is unknown below head ${head}`)
            )
          }
          if (block.number !== blockNumber) {
            return yield* rpc.fail(
              endpoint,
              method,
              new JsonRpc.InvalidResponse(),
              new Error(`block ${block.number} answered for block ${blockNumber}`)
            )
          }
          return block
        })

      const getLogsOn = (endpoint: Endpoint, filter: EvmLogsFilter) =>
        Effect.gen(function*() {
          const method = RpcMethods.getLogs.name
          yield* rpc.requireHead(endpoint, method, filter.toBlock, blockNumberOn(endpoint))
          const { addresses, ...range } = filter
          const logs = yield* rpc.call(endpoint, RpcMethods.getLogs, [{ ...range, address: addresses }])
          const allowed = new Set<string>(addresses)
          const invalid = logs.find((log) =>
            log.blockNumber < filter.fromBlock || log.blockNumber > filter.toBlock ||
            !allowed.has(log.address)
          )
          if (invalid !== undefined) {
            return yield* rpc.fail(
              endpoint,
              method,
              new JsonRpc.InvalidResponse(),
              new Error(`log ${invalid.transactionHash}#${invalid.logIndex} is outside the filter`)
            )
          }
          return Arr.sort(logs.map(({ removed: _removed, ...log }) => log), byBlockThenIndex)
        })

      return EvmRpc.of({
        network,
        chainId: rpc.withFallback(rpc.checkNetwork),
        blockNumber: rpc.withFallback(blockNumberOn),
        getBlockByNumber: ({ blockNumber }) =>
          rpc.withFallback((endpoint) => getBlockByNumberOn(endpoint, blockNumber)),
        getLogs: (filter) =>
          filter.fromBlock > filter.toBlock
            ? Effect.succeed([])
            : rpc.withFallback((endpoint) => getLogsOn(endpoint, filter))
      })
    })
  )

/**
 * Builds an {@link EvmRpc} like {@link layer}, reading the options from `Config`. Endpoint URLs stay `Redacted`.
 *
 * @example
 * ```ts
 * import * as EvmRpc from "@effect-blockchain/evm/EvmRpc"
 * import * as Config from "effect/Config"
 *
 * const RpcLive = EvmRpc.layerConfig({
 *   network: Config.succeed("Ethereum"),
 *   endpoints: Config.all([Config.all({ name: Config.succeed("main"), url: Config.Redacted("ETHEREUM_RPC_URL") })])
 * })
 * ```
 *
 * @since 0.1.0
 * @category layers
 */
export const layerConfig = (
  options: Config.Wrap<Parameters<typeof layer>[0]>
): Layer.Layer<EvmRpc, Config.ConfigError, HttpClient.HttpClient> =>
  Layer.unwrap(Effect.map(Config.unwrap(options), layer))
