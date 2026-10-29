/**
 * Raw Starknet event indexer over JSON-RPC.
 *
 * @since 0.1.0
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import { RpcProvider } from "starknet"
import { PaddedFelt } from "./internal/felt.ts"
import { StarknetAddress } from "./StarknetAddress.ts"
import type { StarknetNetwork } from "./StarknetNetwork.ts"
import { defaultConfirmations } from "./StarknetNetwork.ts"
import { StarknetTransactionHash } from "./StarknetTransactionHash.ts"

/**
 * @since 0.1.0
 * @category errors
 */
export class StarknetIndexerError extends Schema.TaggedError<StarknetIndexerError>()("StarknetIndexerError", {
  reason: Schema.String,
  cause: Schema.Defect()
}) {
  /**
   * @since 0.1.0
   */
  static fromCause = (reason: string) => (cause: unknown) => new StarknetIndexerError({ reason, cause })
}

/**
 * A raw event emitted by a contract. `keys` and `data` are felts as `0x` + 64
 * lowercase hex digits, `eventIndex` is the position of the event within its
 * transaction.
 *
 * @since 0.1.0
 * @category models
 */
export interface StarknetEvent {
  readonly fromAddress: StarknetAddress
  readonly keys: ReadonlyArray<string>
  readonly data: ReadonlyArray<string>
  readonly blockNumber: bigint
  readonly transactionHash: StarknetTransactionHash
  readonly eventIndex: number
}

/**
 * @since 0.1.0
 * @category services
 */
export class StarknetIndexer extends Context.Service<StarknetIndexer, {
  /**
   * The latest accepted block minus the configured confirmations, never below 0.
   */
  readonly lastConfirmedBlock: Effect.Effect<bigint, StarknetIndexerError>
  /**
   * Events emitted by `address` between `fromBlock` and `toBlock` (inclusive),
   * ordered by block, transaction and event index.
   */
  readonly fetchEvents: (options: {
    readonly address: StarknetAddress
    readonly fromBlock: bigint
    readonly toBlock: bigint
  }) => Effect.Effect<ReadonlyArray<StarknetEvent>, StarknetIndexerError>
}>()("@effect-blockchain/starknet/StarknetIndexer") {}

const RpcEvent = Schema.Struct({
  from_address: StarknetAddress,
  keys: Schema.Array(PaddedFelt),
  data: Schema.Array(PaddedFelt)
})

const EventsChunk = Schema.Struct({
  events: Schema.Array(Schema.Struct({
    ...RpcEvent.fields,
    // absent on pre-confirmed events
    block_number: Schema.optional(Schema.Number),
    transaction_hash: StarknetTransactionHash,
    // returned since RPC 0.10, starknet.js 8 nodes (RPC 0.8/0.9) need the receipt instead
    event_index: Schema.optional(Schema.Number)
  })),
  continuation_token: Schema.optional(Schema.String)
})

const Receipt = Schema.Struct({ events: Schema.Array(RpcEvent) })

const RpcResponse = Schema.Struct({
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Struct({ code: Schema.Number, message: Schema.String }))
})

const isRateLimited = (error: StarknetIndexerError) => error.cause instanceof Response && error.cause.status === 429

const rateLimitRetry = Schedule.max([Schedule.exponential("500 millis", 2).pipe(Schedule.jittered), Schedule.recurs(5)])

/**
 * Builds a `StarknetIndexer` for one network. `confirmations` overrides the
 * network default, `chunkSize` is the `starknet_getEvents` page size and
 * `fetch` replaces the global fetch used for RPC calls.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer = (options: {
  readonly network: StarknetNetwork
  readonly rpcUrl: string
  readonly confirmations?: number | undefined
  readonly chunkSize?: number | undefined
  readonly fetch?: typeof globalThis.fetch | undefined
}): Layer.Layer<StarknetIndexer> =>
  Layer.sync(StarknetIndexer, () => {
    const provider = new RpcProvider({
      nodeUrl: options.rpcUrl,
      ...(options.fetch !== undefined && { baseFetch: options.fetch })
    })
    const confirmations = options.confirmations ?? defaultConfirmations(options.network)
    const chunkSize = options.chunkSize ?? 1000

    const rpc = <A>(method: string, params: object | undefined, schema: Schema.Decoder<A>) =>
      Effect.gen(function*() {
        const response = yield* Effect.tryPromise({
          try: () => provider.fetch(method, params),
          catch: StarknetIndexerError.fromCause(`${method}: request failed`)
        })
        if (!response.ok) {
          return yield* new StarknetIndexerError({ reason: `${method}: HTTP ${response.status}`, cause: response })
        }
        const json = yield* Effect.tryPromise({
          try: () => response.json(),
          catch: StarknetIndexerError.fromCause(`${method}: invalid JSON response`)
        })
        const body = yield* Schema.decodeUnknownEffect(RpcResponse)(json).pipe(
          Effect.mapError(StarknetIndexerError.fromCause(`${method}: unexpected response`))
        )
        if (body.error !== undefined) {
          return yield* new StarknetIndexerError({
            reason: `${method}: RPC error ${body.error.code}`,
            cause: body.error
          })
        }
        return yield* Schema.decodeUnknownEffect(schema)(body.result).pipe(
          Effect.mapError(StarknetIndexerError.fromCause(`${method}: unexpected result`))
        )
      }).pipe(Effect.retry({ schedule: rateLimitRetry, while: isRateLimited }))

    const lastConfirmedBlock = rpc("starknet_blockNumber", undefined, Schema.Number).pipe(
      Effect.map((head) => BigInt(Math.max(head - confirmations, 0))),
      Effect.withSpan("StarknetIndexer.lastConfirmedBlock")
    )

    const fetchEvents = Effect.fn("StarknetIndexer.fetchEvents")(function*({ address, fromBlock, toBlock }: {
      readonly address: StarknetAddress
      readonly fromBlock: bigint
      readonly toBlock: bigint
    }) {
      const events: Array<StarknetEvent> = []
      // per transaction: receipt events and the next position to match from
      const receipts = new Map<string, { events: typeof Receipt.Type.events; next: number }>()
      let continuationToken: string | undefined
      if (fromBlock > toBlock) return events
      do {
        const chunk = yield* rpc("starknet_getEvents", {
          filter: {
            address,
            from_block: { block_number: Number(fromBlock) },
            to_block: { block_number: Number(toBlock) },
            chunk_size: chunkSize,
            ...(continuationToken !== undefined && { continuation_token: continuationToken })
          }
        }, EventsChunk)
        for (const event of chunk.events) {
          if (event.block_number === undefined) continue
          let eventIndex = event.event_index
          if (eventIndex === undefined) {
            let receipt = receipts.get(event.transaction_hash)
            if (receipt === undefined) {
              const { events } = yield* rpc("starknet_getTransactionReceipt", {
                transaction_hash: event.transaction_hash
              }, Receipt)
              receipt = { events, next: 0 }
              receipts.set(event.transaction_hash, receipt)
            }
            // getEvents keeps emission order within a transaction, so identical events match in order
            const key = JSON.stringify([event.from_address, event.keys, event.data])
            eventIndex = receipt.events.findIndex((candidate, index) =>
              index >= receipt!.next && JSON.stringify([candidate.from_address, candidate.keys, candidate.data]) === key
            )
            if (eventIndex === -1) {
              return yield* new StarknetIndexerError({
                reason: `starknet_getTransactionReceipt: event not found in ${event.transaction_hash}`,
                cause: event
              })
            }
            receipt.next = eventIndex + 1
          }
          events.push({
            fromAddress: event.from_address,
            keys: event.keys,
            data: event.data,
            blockNumber: BigInt(event.block_number),
            transactionHash: event.transaction_hash,
            eventIndex
          })
        }
        continuationToken = chunk.continuation_token
      } while (continuationToken !== undefined)
      return events
    })

    return StarknetIndexer.of({ lastConfirmedBlock, fetchEvents })
  })
