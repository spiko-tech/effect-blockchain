/**
 * Typed, read-only standard EVM JSON-RPC methods, served by an ordered list of endpoints with fallback.
 *
 * Every call starts at the first endpoint. An endpoint failure that another endpoint could answer (see
 * {@link EvmRpcError}) moves to the next endpoint, any other failure stops at once. Before its first call, each
 * endpoint is checked to serve the configured network (`eth_chainId`), once.
 *
 * Every method is a read and safe to repeat, which is what makes the fallback and viem's retries sound. A future write
 * method (e.g. `eth_sendRawTransaction`) must take a transaction signed outside this module, resend the same signed
 * bytes on fallback, never retry blindly after an unclear failure and confirm the outcome by transaction hash.
 *
 * Adding a method takes three steps:
 * 1. define it once in `internal/rpcMethods.ts`: its JSON-RPC name, a params codec and a result codec,
 * 2. add one line to the {@link EvmRpc} service and its layer, calling it through the shared `call`, which does the
 *    network check, the request, the error classification, the decoding and the span,
 * 3. add one test decoding a fake response.
 *
 * Methods are named after the JSON-RPC method without its namespace (`eth_getLogs` is `getLogs`).
 *
 * @since 0.1.0
 */
import * as Arr from "effect/Array"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Order from "effect/Order"
import * as Redacted from "effect/Redacted"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as SynchronizedRef from "effect/SynchronizedRef"
import { BaseError, http, HttpRequestError, TimeoutError, UnknownRpcError } from "viem"
import type { EvmAddress } from "./EvmAddress.ts"
import type { EvmHexData } from "./EvmHexData.ts"
import type { EvmLog } from "./EvmLog.ts"
import * as EvmNetwork from "./EvmNetwork.ts"
import { redactRpcUrl } from "./internal/redactRpcUrl.ts"
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
 * | `Unavailable` | transport, timeout, HTTP error status, rate-limit or internal error codes, after viem's retries | yes |
 * | `InvalidResponse` | the result fails its schema, or a log fails the `getLogs` checks | yes |
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
export interface EvmLogFilter {
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
  readonly chainId: Effect.Effect<number, EvmRpcError>
  /** `eth_blockNumber` */
  readonly blockNumber: Effect.Effect<bigint, EvmRpcError>
  /**
   * `eth_getLogs`, only answered by an endpoint whose head has reached `toBlock`. Logs are sorted by block then log
   * index. A removed, pending or out-of-filter log fails with `InvalidResponse`. An empty range returns `[]`.
   */
  readonly getLogs: (filter: EvmLogFilter) => Effect.Effect<ReadonlyArray<EvmLog>, EvmRpcError>
}>()("@effect-blockchain/evm/EvmRpc") {}

const fallbackReasons: ReadonlySet<EvmRpcErrorReason> = new Set([
  "Unavailable",
  "InvalidResponse",
  "Lagging",
  "Pruned"
])

// viem retries these codes, so they mean the endpoint is struggling, not that the request is wrong
const unavailableCodes: ReadonlySet<number> = new Set([-32005, -32603, 429, -32007, -1])

const classify = (error: unknown): { readonly reason: EvmRpcErrorReason; readonly code?: number | undefined } => {
  if (error instanceof HttpRequestError) return { reason: "Unavailable", code: error.status }
  if (error instanceof TimeoutError || error instanceof UnknownRpcError) return { reason: "Unavailable" }
  if (error instanceof BaseError && "code" in error && typeof error.code === "number") {
    return { reason: unavailableCodes.has(error.code) ? "Unavailable" : "Rejected", code: error.code }
  }
  return { reason: "Unavailable" }
}

const byBlockThenIndex = Order.combine(
  Order.mapInput(Order.BigInt, (log: EvmLog) => log.blockNumber),
  Order.mapInput(Order.Number, (log: EvmLog) => log.logIndex)
)

type NetworkCheck = "Unchecked" | "Checked" | EvmRpcError

/**
 * Builds an {@link EvmRpc} over `endpoints`, tried in order.
 *
 * - `timeout` bounds each attempt, default 30 seconds.
 * - `retries` is the number of viem retries per endpoint before falling back, default 3. viem retries rate limits,
 *   timeouts, HTTP 403/408/413/429/5xx and a few internal or rate-limit JSON-RPC codes with an exponential backoff
 *   from `retryDelay` (default 150 millis), honoring `Retry-After`.
 * - `fetch` replaces the global `fetch`, e.g. for a proxy or in tests.
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
  readonly fetch?: typeof globalThis.fetch | undefined
}): Layer.Layer<EvmRpc> =>
  Layer.effect(
    EvmRpc,
    Effect.gen(function*() {
      const { network } = options
      const expectedChainId = EvmNetwork.toChainId(network)

      const endpoints = yield* Effect.forEach(options.endpoints, (endpoint) =>
        Effect.gen(function*() {
          const url = Redacted.value(endpoint.url)
          const transport = http(url, {
            timeout: Duration.toMillis(options.timeout ?? Duration.seconds(30)),
            retryCount: options.retries ?? 3,
            retryDelay: Duration.toMillis(options.retryDelay ?? Duration.millis(150)),
            fetchFn: options.fetch
          })({})
          return {
            name: endpoint.name,
            url,
            transport,
            networkCheck: yield* SynchronizedRef.make<NetworkCheck>("Unchecked"),
            head: yield* Ref.make(BigInt(-1))
          }
        }))
      type Endpoint = typeof endpoints[number]

      const fail = (endpoint: Endpoint, method: string, reason: EvmRpcErrorReason, cause: Error) =>
        new EvmRpcError({ reason, method, endpoint: endpoint.name, cause })

      const send = <Params, A>(endpoint: Endpoint, method: RpcMethods.RpcMethod<Params, A>, params: Params) =>
        Effect.gen(function*() {
          const encoded = yield* Schema.encodeEffect(method.params)(params).pipe(
            Effect.mapError((cause) => fail(endpoint, method.name, "Rejected", cause))
          )
          const raw = yield* Effect.tryPromise({
            try: (signal) => endpoint.transport.request({ method: method.name, params: encoded }, { signal }),
            catch: (error) =>
              new EvmRpcError({
                ...classify(error),
                method: method.name,
                endpoint: endpoint.name,
                cause: redactRpcUrl(error, endpoint.url)
              })
          })
          return yield* Schema.decodeUnknownEffect(method.result)(raw).pipe(
            Effect.mapError((cause) => fail(endpoint, method.name, "InvalidResponse", cause))
          )
        }).pipe(
          Effect.withSpan(`EvmRpc.${method.name}`, {
            attributes: { network, endpoint: endpoint.name, method: method.name }
          })
        )

      // a mismatch is kept, a failed check is not: the next call checks again
      const checkNetwork = (endpoint: Endpoint) =>
        SynchronizedRef.modifyEffect(endpoint.networkCheck, (state) =>
          state !== "Unchecked"
            ? Effect.succeed([state, state] as const)
            : send(endpoint, RpcMethods.chainId, []).pipe(
              Effect.map((chainId): NetworkCheck =>
                chainId === expectedChainId ?
                  "Checked" :
                  fail(
                    endpoint,
                    RpcMethods.chainId.name,
                    "WrongNetwork",
                    new Error(`expected chain ID ${expectedChainId} for ${network}, got ${chainId}`)
                  )
              ),
              Effect.map((checked) => [checked, checked] as const)
            )).pipe(Effect.flatMap((state) => state instanceof EvmRpcError ? Effect.fail(state) : Effect.void))

      const call = <Params, A>(endpoint: Endpoint, method: RpcMethods.RpcMethod<Params, A>, params: Params) =>
        checkNetwork(endpoint).pipe(Effect.andThen(send(endpoint, method, params)))

      const withFallback = Effect.fnUntraced(function*<A>(
        f: (endpoint: Endpoint) => Effect.Effect<A, EvmRpcError>
      ): Effect.fn.Return<A, EvmRpcError> {
        const errors: Array<EvmRpcError> = []
        for (const endpoint of endpoints) {
          const result = yield* Effect.result(f(endpoint))
          if (Result.isSuccess(result)) return result.success
          errors.push(result.failure)
          if (!fallbackReasons.has(result.failure.reason)) break
        }
        const last = errors[errors.length - 1]
        if (errors.length === 1) return yield* last
        return yield* new EvmRpcError({
          reason: last.reason,
          method: last.method,
          endpoint: last.endpoint,
          code: last.code,
          cause: new AggregateError(errors, `${errors.length} endpoints failed`)
        })
      })

      const blockNumberOn = (endpoint: Endpoint) =>
        call(endpoint, RpcMethods.blockNumber, []).pipe(
          Effect.tap((head) => Ref.update(endpoint.head, (known) => head > known ? head : known))
        )

      const getLogsOn = (endpoint: Endpoint, filter: EvmLogFilter) =>
        Effect.gen(function*() {
          const method = RpcMethods.getLogs.name
          if ((yield* Ref.get(endpoint.head)) < filter.toBlock) {
            const head = yield* blockNumberOn(endpoint)
            if (head < filter.toBlock) {
              return yield* fail(
                endpoint,
                method,
                "Lagging",
                new Error(`head ${head} is below toBlock ${filter.toBlock}`)
              )
            }
          }
          const addresses = new Set<string>(Arr.ensure(filter.address))
          const logs = yield* call(endpoint, RpcMethods.getLogs, [filter])
          const invalid = logs.find((log) =>
            log.blockNumber < filter.fromBlock || log.blockNumber > filter.toBlock ||
            !addresses.has(log.address)
          )
          if (invalid !== undefined) {
            return yield* fail(
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
        chainId: withFallback((endpoint) => checkNetwork(endpoint).pipe(Effect.as(expectedChainId))),
        blockNumber: withFallback(blockNumberOn),
        getLogs: (filter) =>
          filter.fromBlock > filter.toBlock
            ? Effect.succeed([])
            : withFallback((endpoint) => getLogsOn(endpoint, filter))
      })
    })
  )
