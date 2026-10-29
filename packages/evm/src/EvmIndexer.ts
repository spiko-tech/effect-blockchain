/**
 * A raw EVM log indexer: reads the last confirmed block and the logs emitted by a contract over a block range.
 *
 * @since 0.1.0
 */
import * as Arr from "effect/Array"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Order from "effect/Order"
import * as Predicate from "effect/Predicate"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import { createPublicClient, http } from "viem"
import * as chains from "viem/chains"
import { EvmAddress } from "./EvmAddress.ts"
import { EvmHexData } from "./EvmHexData.ts"
import * as EvmNetwork from "./EvmNetwork.ts"
import { EvmTransactionHash } from "./EvmTransactionHash.ts"
import { redactRpcUrl } from "./internal/redactRpcUrl.ts"

/**
 * A raw, undecoded log emitted by a contract in a confirmed block.
 *
 * `logIndex` is the position of the log in its block (EVM log indexes are per block, not per transaction).
 *
 * @since 0.1.0
 * @category schemas
 */
export const EvmLog = Schema.Struct({
  address: EvmAddress,
  topics: Schema.Array(EvmHexData),
  data: EvmHexData,
  blockNumber: Schema.BigInt,
  blockHash: EvmHexData,
  transactionHash: EvmTransactionHash,
  logIndex: Schema.Int
}).annotate({ identifier: "EvmLog", title: "EVM log" })

/**
 * @since 0.1.0
 * @category models
 */
export type EvmLog = typeof EvmLog.Type

/**
 * @since 0.1.0
 * @category errors
 */
export class EvmIndexerError extends Schema.TaggedError<EvmIndexerError>()("EvmIndexerError", {
  reason: Schema.String,
  cause: Schema.Defect()
}) {
  /**
   * @since 0.1.0
   */
  static fromCause = (reason: string) => (cause: unknown) => new EvmIndexerError({ reason, cause })
}

/**
 * @since 0.1.0
 * @category services
 */
export class EvmIndexer extends Context.Service<EvmIndexer, {
  /** The head block number minus the confirmations, never below 0. */
  readonly lastConfirmedBlock: Effect.Effect<bigint, EvmIndexerError>
  /**
   * The logs emitted by `address` between `fromBlock` and `toBlock` (both inclusive), ordered by block then log index.
   * The range is split into chunks of at most `maxBlockRange` blocks, fetched sequentially.
   */
  readonly fetchLogs: (params: {
    readonly address: EvmAddress
    readonly fromBlock: bigint
    readonly toBlock: bigint
  }) => Effect.Effect<ReadonlyArray<EvmLog>, EvmIndexerError>
}>()("@effect-blockchain/evm/EvmIndexer") {}

/**
 * The default `maxBlockRange`: most RPC providers accept `eth_getLogs` over 1000 blocks, lower it for stricter ones.
 *
 * @since 0.1.0
 * @category constants
 */
export const DEFAULT_MAX_BLOCK_RANGE = 1000

const isRateLimited = (u: unknown): boolean =>
  (Predicate.hasProperty(u, "status") && u.status === 429) ||
  (Predicate.hasProperty(u, "cause") && isRateLimited(u.cause))

const byBlockThenIndex = Order.combine(
  Order.mapInput(Order.BigInt, (log: EvmLog) => log.blockNumber),
  Order.mapInput(Order.Number, (log: EvmLog) => log.logIndex)
)

/**
 * Builds an {@link EvmIndexer} reading from `rpcUrl`.
 *
 * - `confirmations` overrides {@link EvmNetwork.defaultConfirmations}.
 * - `maxBlockRange` defaults to {@link DEFAULT_MAX_BLOCK_RANGE}.
 * - HTTP 429 responses are retried up to 5 times with jittered exponential backoff from 500ms; other errors are not.
 * - A log marked `removed` or still pending (null block or transaction fields) fails with an {@link EvmIndexerError}:
 *   it means a reorg deeper than the confirmations, so skipping it would silently lose data.
 * - The RPC URL is redacted from error causes since it often embeds an API key.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer = (options: {
  readonly network: EvmNetwork.EvmNetwork
  readonly rpcUrl: string
  readonly confirmations?: number | undefined
  readonly maxBlockRange?: number | undefined
}): Layer.Layer<EvmIndexer> =>
  Layer.sync(EvmIndexer, () => {
    const chainId = EvmNetwork.toChainId(options.network)
    const client = createPublicClient({
      chain: Object.values(chains).find((chain) => chain.id === chainId),
      // retries are handled below, only on 429
      transport: http(options.rpcUrl, { retryCount: 0 })
    })
    const confirmations = BigInt(options.confirmations ?? EvmNetwork.defaultConfirmations(options.network))
    const maxBlockRange = BigInt(options.maxBlockRange ?? DEFAULT_MAX_BLOCK_RANGE)

    const request = <A>(reason: string, f: () => Promise<A>) =>
      Effect.tryPromise({
        try: f,
        catch: (cause) => new EvmIndexerError({ reason, cause: redactRpcUrl(cause, options.rpcUrl) })
      }).pipe(
        Effect.retry({
          schedule: Schedule.exponential("500 millis").pipe(Schedule.jittered),
          times: 5,
          while: (error) => isRateLimited(error.cause)
        })
      )

    const decodeLog = (log: unknown) =>
      Predicate.hasProperty(log, "removed") && log.removed === true
        ? Effect.fail(new EvmIndexerError({ reason: "EvmIndexer.fetchLogs: log removed by a reorg", cause: log }))
        : Schema.decodeUnknownEffect(EvmLog)(log).pipe(
          Effect.mapError(EvmIndexerError.fromCause("EvmIndexer.fetchLogs: invalid or pending log"))
        )

    return EvmIndexer.of({
      lastConfirmedBlock: request(
        "EvmIndexer.lastConfirmedBlock: failed to get block number",
        () => client.getBlockNumber({ cacheTime: 0 })
      ).pipe(
        Effect.map((head) => head > confirmations ? head - confirmations : BigInt(0)),
        Effect.withSpan("EvmIndexer.lastConfirmedBlock", { attributes: { network: options.network } })
      ),
      fetchLogs: Effect.fn("EvmIndexer.fetchLogs")(function*({ address, fromBlock, toBlock }: {
        readonly address: EvmAddress
        readonly fromBlock: bigint
        readonly toBlock: bigint
      }) {
        const logs: Array<EvmLog> = []
        for (let start = fromBlock; start <= toBlock; start += maxBlockRange) {
          const end = start + maxBlockRange - BigInt(1) < toBlock ? start + maxBlockRange - BigInt(1) : toBlock
          const chunk = yield* request(
            "EvmIndexer.fetchLogs: failed to get logs",
            () => client.getLogs({ address, fromBlock: start, toBlock: end })
          )
          for (const log of chunk) logs.push(yield* decodeLog(log))
        }
        return Arr.sort(logs, byBlockThenIndex)
      })
    })
  })
