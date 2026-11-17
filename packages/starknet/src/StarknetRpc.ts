/**
 * Typed Starknet JSON-RPC methods over an ordered list of endpoints with fallback.
 *
 * A call starts at the first endpoint and moves to the next one on failure, except on `WrongNetwork`. Each endpoint
 * is checked once to serve the configured network (`starknet_chainId`). Every method but `addInvokeTransaction`
 * and `addDeployAccountTransaction` is a read, so retries and fallback are safe; these two document their own case.
 * Methods are named after the JSON-RPC method without its namespace (`starknet_getEvents` is `getEvents`). A
 * `getEvents` page cursor is only sent to the endpoint that issued it, with no fallback.
 *
 * @example
 * ```ts
 * import type { StarknetAddress } from "@effect-blockchain/starknet/StarknetAddress"
 * import type { StarknetEvent } from "@effect-blockchain/starknet/StarknetEvent"
 * import * as StarknetRpc from "@effect-blockchain/starknet/StarknetRpc"
 * import * as Effect from "effect/Effect"
 *
 * declare const address: StarknetAddress
 *
 * // every event of `address` in blocks 100 to 200, page by page
 * const events = Effect.gen(function*() {
 *   const rpc = yield* StarknetRpc.StarknetRpc
 *   const all: Array<StarknetEvent> = []
 *   let cursor: StarknetRpc.StarknetEventsCursor | undefined
 *   do {
 *     const page = yield* rpc.getEvents({ address, fromBlock: BigInt(100), toBlock: BigInt(200), cursor })
 *     all.push(...page.events)
 *     cursor = page.cursor
 *   } while (cursor !== undefined)
 *   return all
 * })
 * ```
 *
 * @since 0.1.0
 */
import * as JsonRpc from "@effect-blockchain/core/JsonRpc"
import * as Arr from "effect/Array"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import type * as HttpClient from "effect/http/HttpClient"
import * as Layer from "effect/Layer"
import type * as Redacted from "effect/Redacted"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as RpcMethods from "./internal/rpcMethods.ts"
import type { StarknetAddress } from "./StarknetAddress.ts"
import type { StarknetBlock } from "./StarknetBlock.ts"
import type { StarknetEvent } from "./StarknetEvent.ts"
import * as StarknetNetwork from "./StarknetNetwork.ts"
import type {
  StarknetDeployAccountTransaction,
  StarknetInvokeTransaction,
  StarknetResourceBounds,
  StarknetTransaction
} from "./StarknetTransaction.ts"
import type { StarknetTransactionHash } from "./StarknetTransactionHash.ts"

/**
 * A JSON-RPC endpoint. The `name` is shown in errors and spans, the `url` is never logged.
 *
 * @since 0.1.0
 * @category models
 */
export interface StarknetRpcEndpoint {
  readonly name: string
  readonly url: Redacted.Redacted<string>
}

/**
 * A failed call: its `reason` (a {@link JsonRpc.Reason}, matched with `Effect.catchReason`), the JSON-RPC error code or
 * HTTP status as `code`, and a `cause` without the endpoint URL. After several endpoints, the error is the last one
 * and `cause` is an `AggregateError` of each endpoint's error, in order.
 *
 * On Starknet, `Unavailable` includes the codes 63 (`UNEXPECTED_ERROR`), -32603, -32005 and 429, `InvalidResponse` an
 * event outside the `getEvents` filter, and `Lagging` a head below the requested block, `BLOCK_NOT_FOUND` (24) and
 * `TXN_HASH_NOT_FOUND` (29).
 *
 * @since 0.1.0
 * @category errors
 */
export class StarknetRpcError extends Schema.TaggedError<StarknetRpcError>()("StarknetRpcError", {
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
 * Where to continue a `starknet_getEvents` range: the provider's continuation token and the endpoint that issued it.
 * Opaque: only pass it back to {@link StarknetRpc} `getEvents` with the same filter.
 *
 * @since 0.1.0
 * @category schemas
 */
export const StarknetEventsCursor = Schema.Struct({
  endpoint: Schema.String,
  cursor: Schema.String
}).pipe(Schema.brand("StarknetEventsCursor"))

/**
 * @since 0.1.0
 * @category models
 */
export type StarknetEventsCursor = typeof StarknetEventsCursor.Type

/**
 * A `starknet_getEvents` filter over the inclusive block range `[fromBlock, toBlock]`.
 *
 * - `keys` filters by position, an empty position matches any key.
 * - `chunkSize` is the page size, default 1000 (providers commonly cap it at 1024).
 * - `cursor` continues the range from a previous page.
 *
 * @since 0.1.0
 * @category models
 */
export interface StarknetEventsFilter {
  readonly address: StarknetAddress
  readonly fromBlock: bigint
  readonly toBlock: bigint
  readonly keys?: ReadonlyArray<ReadonlyArray<string>> | undefined
  readonly chunkSize?: number | undefined
  readonly cursor?: StarknetEventsCursor | undefined
}

/**
 * One page of events. `cursor` is `undefined` when the range is done.
 *
 * @since 0.1.0
 * @category models
 */
export interface StarknetEventsPage {
  readonly events: ReadonlyArray<StarknetEvent>
  readonly cursor: StarknetEventsCursor | undefined
}

/**
 * The part of a confirmed transaction receipt an indexer needs. `events` are in emission order.
 *
 * @since 0.1.0
 * @category models
 */
export interface StarknetTransactionReceipt {
  readonly transactionHash: StarknetTransactionHash
  readonly blockNumber: bigint
  readonly blockHash: string
  readonly events: ReadonlyArray<Pick<StarknetEvent, "fromAddress" | "keys" | "data">>
}

/**
 * The `starknet_getTransactionStatus` result of the JSON-RPC spec v0.9. `executionStatus` is absent until the
 * transaction is executed (`RECEIVED`, `CANDIDATE`), and `failureReason` is the node's revert message of a `REVERTED`
 * transaction.
 *
 * @since 0.2.0
 * @category models
 */
export interface StarknetTransactionStatusResult {
  readonly finalityStatus: "RECEIVED" | "CANDIDATE" | "PRE_CONFIRMED" | "ACCEPTED_ON_L2" | "ACCEPTED_ON_L1"
  readonly executionStatus?: "SUCCEEDED" | "REVERTED" | undefined
  readonly failureReason?: string | undefined
}

/**
 * The block a state read is made at: the latest accepted block, or the pre-confirmed block being built on top of it.
 *
 * @since 0.2.0
 * @category models
 */
export type StarknetBlockTag = "latest" | "pre_confirmed"

/**
 * One `starknet_estimateFee` result: the amount of each resource a transaction consumes and its price, in FRI (10^-18
 * STRK) per unit. `overallFee` is their total.
 *
 * @since 0.2.0
 * @category models
 */
export interface StarknetFeeEstimate {
  readonly l1GasConsumed: bigint
  readonly l1GasPrice: bigint
  readonly l1DataGasConsumed: bigint
  readonly l1DataGasPrice: bigint
  readonly l2GasConsumed: bigint
  readonly l2GasPrice: bigint
  readonly overallFee: bigint
}

/**
 * @since 0.1.0
 * @category services
 */
export class StarknetRpc extends Context.Service<StarknetRpc, {
  readonly network: StarknetNetwork.StarknetNetwork
  /** `starknet_chainId`, verified against `network` once per endpoint then served from that check. */
  readonly chainId: Effect.Effect<StarknetNetwork.StarknetChainId, StarknetRpcError>
  /** `starknet_blockNumber` */
  readonly blockNumber: Effect.Effect<bigint, StarknetRpcError>
  /**
   * `starknet_getBlockWithTxHashes`, only answered by an endpoint whose head has reached `blockNumber`. A pre-confirmed
   * block fails with `InvalidResponse`.
   */
  readonly getBlockWithTxHashes: (
    options: { readonly blockNumber: bigint }
  ) => Effect.Effect<StarknetBlock, StarknetRpcError>
  /**
   * `starknet_getEvents`, one page, only answered by an endpoint whose head has reached `toBlock`. Events keep the
   * provider's order, which is chain order (`event_index` is not always returned to sort them). A pre-confirmed or
   * out-of-filter event fails with `InvalidResponse`, and an empty range returns no events.
   */
  readonly getEvents: (filter: StarknetEventsFilter) => Effect.Effect<StarknetEventsPage, StarknetRpcError>
  /**
   * `starknet_call`, the raw felts a view function returns at the end of `blockNumber`, only answered by an endpoint
   * whose head has reached `blockNumber`.
   */
  readonly call: (options: {
    readonly contractAddress: StarknetAddress
    readonly entryPointSelector: string
    readonly calldata: ReadonlyArray<string>
    readonly blockNumber: bigint
  }) => Effect.Effect<ReadonlyArray<string>, StarknetRpcError>
  /** `starknet_getTransactionReceipt`. A pre-confirmed receipt fails with `InvalidResponse`. */
  readonly getTransactionReceipt: (
    options: { readonly transactionHash: StarknetTransactionHash }
  ) => Effect.Effect<StarknetTransactionReceipt, StarknetRpcError>
  /**
   * `starknet_getTransactionStatus`, `null` when no endpoint knows the transaction: at least one answered
   * `TXN_HASH_NOT_FOUND` (29) and every other one failed with a transient reason (`JsonRpc.isTransient`).
   */
  readonly getTransactionStatus: (
    options: { readonly transactionHash: StarknetTransactionHash }
  ) => Effect.Effect<StarknetTransactionStatusResult | null, StarknetRpcError>
  /**
   * `starknet_getNonce`: the nonce of the next transaction of the account at `address`. `pre_confirmed` counts the
   * transactions of the block being built, not the ones still waiting in the mempool. An address without a contract
   * is `Rejected` with the code 20 (`CONTRACT_NOT_FOUND`).
   *
   * @since 0.2.0
   */
  readonly getNonce: (options: {
    readonly address: StarknetAddress
    readonly blockTag: StarknetBlockTag
  }) => Effect.Effect<bigint, StarknetRpcError>
  /**
   * `starknet_estimateFee`: one estimate per transaction, each executed on top of the previous ones at `blockTag`
   * (a reply without an estimate is an `InvalidResponse`).
   * `skipValidate` sends the `SKIP_VALIDATE` flag, which accepts unsigned transactions. A transaction that fails is
   * `Rejected` with the code 41 (`TRANSACTION_EXECUTION_ERROR`) and the node's message in `cause`.
   *
   * @since 0.2.0
   */
  readonly estimateFee: (options: {
    readonly transactions: Arr.NonEmptyReadonlyArray<StarknetTransaction>
    readonly skipValidate?: boolean | undefined
    readonly blockTag: StarknetBlockTag
  }) => Effect.Effect<Arr.NonEmptyReadonlyArray<StarknetFeeEstimate>, StarknetRpcError>
  /**
   * `starknet_addInvokeTransaction`: submits a signed `INVOKE` transaction and returns its hash. A retry or a fallback
   * sends the same transaction, so it never creates a second one, but a node that already has it refuses the second
   * copy. A refusal (`DUPLICATE_TX`, `INVALID_TRANSACTION_NONCE`, `INSUFFICIENT_ACCOUNT_BALANCE`...) is `Rejected`,
   * with the spec's error code as `code`.
   *
   * @since 0.2.0
   */
  readonly addInvokeTransaction: (options: {
    readonly transaction: StarknetInvokeTransaction
  }) => Effect.Effect<StarknetTransactionHash, StarknetRpcError>
  /**
   * `starknet_addDeployAccountTransaction`: submits a signed `DEPLOY_ACCOUNT` transaction and returns its hash and
   * the address of the account. Retries, fallback and refusals are those of `addInvokeTransaction`.
   *
   * @since 0.2.0
   */
  readonly addDeployAccountTransaction: (options: {
    readonly transaction: StarknetDeployAccountTransaction
  }) => Effect.Effect<
    { readonly transactionHash: StarknetTransactionHash; readonly contractAddress: StarknetAddress },
    StarknetRpcError
  >
}>()("@effect-blockchain/starknet/StarknetRpc") {}

const TXN_HASH_NOT_FOUND = 29

// error codes from the Starknet JSON-RPC spec v0.9 (starknet_api_openrpc.json), plus the common provider ones
const codes: ReadonlyMap<number, JsonRpc.CodeReason> = new Map([
  // UNEXPECTED_ERROR, JSON-RPC internal error and provider rate limits: the endpoint is struggling, retry then fall back
  [63, "Unavailable"],
  [-32603, "Unavailable"],
  [-32005, "Unavailable"],
  [429, "Unavailable"],
  // BLOCK_NOT_FOUND, TXN_HASH_NOT_FOUND: another endpoint may be further ahead
  [24, "Lagging"],
  [TXN_HASH_NOT_FOUND, "Lagging"]
])

const bound = (bound: StarknetResourceBounds["l1Gas"]) => ({
  max_amount: bound.maxAmount,
  max_price_per_unit: bound.maxPricePerUnit
})

const v3 = (transaction: StarknetTransaction) => ({
  version: "0x3" as const,
  signature: transaction.signature,
  nonce: transaction.nonce,
  resource_bounds: {
    l1_gas: bound(transaction.resourceBounds.l1Gas),
    l2_gas: bound(transaction.resourceBounds.l2Gas),
    l1_data_gas: bound(transaction.resourceBounds.l1DataGas)
  },
  tip: transaction.tip,
  paymaster_data: [] as const,
  nonce_data_availability_mode: "L1" as const,
  fee_data_availability_mode: "L1" as const
})

const invoke = (transaction: StarknetInvokeTransaction) => ({
  type: transaction.type,
  sender_address: transaction.senderAddress,
  calldata: transaction.calldata,
  account_deployment_data: [] as const,
  ...v3(transaction)
})

const deployAccount = (transaction: StarknetDeployAccountTransaction) => ({
  type: transaction.type,
  class_hash: transaction.classHash,
  contract_address_salt: transaction.contractAddressSalt,
  constructor_calldata: transaction.constructorCalldata,
  ...v3(transaction)
})

/**
 * Builds a {@link StarknetRpc} over `endpoints`, tried in order, sending requests with the provided `HttpClient`
 * (e.g. `FetchHttpClient.layer`). `timeout` (default 30 seconds) bounds each attempt, `retries` (default 3) and
 * `retryDelay` (default 500 millis) set the backoff before falling back: see {@link JsonRpc.Unavailable}.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer = (options: {
  readonly network: StarknetNetwork.StarknetNetwork
  readonly endpoints: Arr.NonEmptyReadonlyArray<StarknetRpcEndpoint>
  readonly timeout?: Duration.Input | undefined
  readonly retries?: number | undefined
  readonly retryDelay?: Duration.Input | undefined
}): Layer.Layer<StarknetRpc, never, HttpClient.HttpClient> =>
  Layer.effect(
    StarknetRpc,
    Effect.gen(function*() {
      const { network } = options
      const expectedChainId = StarknetNetwork.toChainId(network)

      const rpc = yield* JsonRpc.make({
        spanPrefix: "StarknetRpc",
        network,
        endpoints: options.endpoints,
        timeout: options.timeout,
        retries: options.retries,
        retryDelay: options.retryDelay,
        codes,
        checkNetwork: (send, endpoint) =>
          send(RpcMethods.chainId, {}).pipe(
            Effect.flatMap((chainId) =>
              chainId === expectedChainId
                ? Effect.succeed(expectedChainId)
                : Effect.fail(
                  new StarknetRpcError({
                    reason: new JsonRpc.WrongNetwork({ expected: expectedChainId, actual: chainId }),
                    method: RpcMethods.chainId.name,
                    endpoint,
                    cause: new Error(`expected chain ID ${expectedChainId} for ${network}, got ${chainId}`)
                  })
                )
            )
          ),
        makeError: (fields: JsonRpc.ErrorFields) => new StarknetRpcError(fields)
      })
      type Endpoint = JsonRpc.Endpoint<StarknetNetwork.StarknetChainId, StarknetRpcError>

      const blockNumberOn = (endpoint: Endpoint) =>
        rpc.call(endpoint, RpcMethods.blockNumber, {}).pipe(
          Effect.tap((head) => Ref.update(endpoint.head, (known) => head > known ? head : known))
        )

      const getEventsOn = (endpoint: Endpoint, filter: StarknetEventsFilter) =>
        Effect.gen(function*() {
          const method = RpcMethods.getEvents.name
          yield* rpc.requireHead(endpoint, method, filter.toBlock, blockNumberOn(endpoint))
          const page = yield* rpc.call(endpoint, RpcMethods.getEvents, {
            filter: {
              address: filter.address,
              from_block: { block_number: filter.fromBlock },
              to_block: { block_number: filter.toBlock },
              ...(filter.keys !== undefined && { keys: filter.keys }),
              chunk_size: filter.chunkSize ?? 1000,
              ...(filter.cursor !== undefined && { continuation_token: filter.cursor.cursor })
            }
          })
          const invalid = page.events.find((event) =>
            event.blockNumber < filter.fromBlock || event.blockNumber > filter.toBlock ||
            event.fromAddress !== filter.address
          )
          if (invalid !== undefined) {
            return yield* rpc.fail(
              endpoint,
              method,
              new JsonRpc.InvalidResponse(),
              new Error(`event of ${invalid.transactionHash} in block ${invalid.blockNumber} is outside the filter`)
            )
          }
          return {
            events: page.events,
            cursor: page.continuation_token === undefined ? undefined : StarknetEventsCursor.make({
              endpoint: endpoint.name,
              cursor: page.continuation_token
            })
          }
        })

      const getEvents = (filter: StarknetEventsFilter): Effect.Effect<StarknetEventsPage, StarknetRpcError> => {
        if (filter.fromBlock > filter.toBlock) return Effect.succeed({ events: [], cursor: undefined })
        if (filter.cursor === undefined) return rpc.withFallback((endpoint) => getEventsOn(endpoint, filter))
        // a cursor only means something to the endpoint that issued it
        return rpc.endpointOf(RpcMethods.getEvents.name, filter.cursor).pipe(
          Effect.flatMap((endpoint) => getEventsOn(endpoint, filter))
        )
      }

      return StarknetRpc.of({
        network,
        chainId: rpc.withFallback(rpc.checkNetwork),
        blockNumber: rpc.withFallback(blockNumberOn),
        getBlockWithTxHashes: ({ blockNumber }) =>
          rpc.withFallback((endpoint) =>
            rpc.requireHead(endpoint, RpcMethods.getBlockWithTxHashes.name, blockNumber, blockNumberOn(endpoint)).pipe(
              Effect.andThen(
                rpc.call(endpoint, RpcMethods.getBlockWithTxHashes, { block_id: { block_number: blockNumber } })
              )
            )
          ),
        getEvents,
        call: (options) =>
          rpc.withFallback((endpoint) =>
            rpc.requireHead(endpoint, RpcMethods.call.name, options.blockNumber, blockNumberOn(endpoint)).pipe(
              Effect.andThen(rpc.call(endpoint, RpcMethods.call, {
                request: {
                  contract_address: options.contractAddress,
                  entry_point_selector: options.entryPointSelector,
                  calldata: options.calldata
                },
                block_id: { block_number: options.blockNumber }
              }))
            )
          ),
        getTransactionReceipt: ({ transactionHash }) =>
          rpc.withFallback((endpoint) =>
            rpc.call(endpoint, RpcMethods.getTransactionReceipt, { transaction_hash: transactionHash })
          ),
        getTransactionStatus: ({ transactionHash }) =>
          rpc.withFallback((endpoint) =>
            rpc.call(endpoint, RpcMethods.getTransactionStatus, { transaction_hash: transactionHash })
          ).pipe(
            Effect.catchIf((error) => {
              const errors = JsonRpc.errorsOf(error).filter((each) => each instanceof StarknetRpcError)
              return errors.some((each) => each.code === TXN_HASH_NOT_FOUND) &&
                errors.every((each) => JsonRpc.isTransient(each.reason))
            }, () => Effect.succeed(null))
          ),
        getNonce: ({ address, blockTag }) =>
          rpc.withFallback((endpoint) =>
            rpc.call(endpoint, RpcMethods.getNonce, { block_id: blockTag, contract_address: address })
          ),
        estimateFee: ({ blockTag, skipValidate, transactions }) =>
          rpc.withFallback((endpoint) =>
            rpc.call(endpoint, RpcMethods.estimateFee, {
              request: Arr.map(
                transactions,
                (transaction) => transaction.type === "INVOKE" ? invoke(transaction) : deployAccount(transaction)
              ),
              simulation_flags: skipValidate === true ? ["SKIP_VALIDATE"] : [],
              block_id: blockTag
            })
          ),
        addInvokeTransaction: ({ transaction }) =>
          rpc.withFallback((endpoint) =>
            rpc.call(endpoint, RpcMethods.addInvokeTransaction, { invoke_transaction: invoke(transaction) })
          ).pipe(Effect.map(({ transactionHash }) => transactionHash)),
        addDeployAccountTransaction: ({ transaction }) =>
          rpc.withFallback((endpoint) =>
            rpc.call(endpoint, RpcMethods.addDeployAccountTransaction, {
              deploy_account_transaction: deployAccount(transaction)
            })
          )
      })
    })
  )

/**
 * Builds an {@link StarknetRpc} like {@link layer}, reading the options from `Config`. Endpoint URLs stay `Redacted`.
 *
 * @example
 * ```ts
 * import * as StarknetRpc from "@effect-blockchain/starknet/StarknetRpc"
 * import * as Config from "effect/Config"
 *
 * const RpcLive = StarknetRpc.layerConfig({
 *   network: Config.succeed("Starknet"),
 *   endpoints: Config.all([Config.all({ name: Config.succeed("main"), url: Config.Redacted("STARKNET_RPC_URL") })])
 * })
 * ```
 *
 * @since 0.1.0
 * @category layers
 */
export const layerConfig = (
  options: Config.Wrap<Parameters<typeof layer>[0]>
): Layer.Layer<StarknetRpc, Config.ConfigError, HttpClient.HttpClient> =>
  Layer.unwrap(Effect.map(Config.unwrap(options), layer))
