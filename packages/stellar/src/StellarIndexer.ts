/**
 * Raw Soroban contract event indexer backed by Stellar RPC `getEvents`.
 *
 * Stellar RPC only retains recent history (120960 ledgers, about 7 days, by default): `fetchEvents` fails with a
 * `StellarIndexerError` when `fromBlock` is older than the RPC's oldest retained ledger. Older ranges need an archive
 * source.
 *
 * @since 0.1.0
 */
import { rpc } from "@stellar/stellar-sdk"
import * as Context from "effect/Context"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import { StellarContractAddress } from "./StellarAddress.ts"
import type { StellarNetwork } from "./StellarNetwork.ts"
import { defaultConfirmations } from "./StellarNetwork.ts"
import { StellarTransactionHash } from "./StellarTransactionHash.ts"

/**
 * @since 0.1.0
 * @category errors
 */
export class StellarIndexerError extends Schema.TaggedError<StellarIndexerError>()("StellarIndexerError", {
  reason: Schema.String,
  cause: Schema.Defect()
}) {
  /**
   * @since 0.1.0
   */
  static fromCause = (reason: string) => (cause: unknown) => new StellarIndexerError({ reason, cause })
}

/**
 * A contract event emitted by a successful transaction, as returned by Stellar RPC.
 *
 * @since 0.1.0
 * @category models
 */
export interface StellarContractEvent {
  /** RPC event id: a 19-digit TOID and a 10-digit event index. Sorting ids as strings gives chain order. */
  readonly id: string
  readonly contractId: StellarContractAddress
  /** Base64 XDR `ScVal`s. */
  readonly topics: ReadonlyArray<string>
  /** Base64 XDR `ScVal`. */
  readonly value: string
  /** Ledger sequence. */
  readonly blockNumber: bigint
  readonly transactionHash: StellarTransactionHash
  /** Index of the event within its operation, which is its transaction for Soroban (one operation per transaction). */
  readonly eventIndex: number
  /** ISO-8601 ledger close time. */
  readonly ledgerClosedAt: string
}

/**
 * @since 0.1.0
 * @category services
 */
export class StellarIndexer extends Context.Service<StellarIndexer, {
  /** Latest ledger minus the configured confirmations, never below 0. */
  readonly lastConfirmedBlock: Effect.Effect<bigint, StellarIndexerError>
  /** Contract events of `address` in the inclusive ledger range, ordered by event id. */
  readonly fetchEvents: (params: {
    readonly address: StellarContractAddress
    readonly fromBlock: bigint
    readonly toBlock: bigint
  }) => Effect.Effect<ReadonlyArray<StellarContractEvent>, StellarIndexerError>
}>()("@effect-blockchain/stellar/StellarIndexer") {}

const isRateLimitError = (error: StellarIndexerError): boolean =>
  Predicate.hasProperty(error.cause, "response") && Predicate.hasProperty(error.cause.response, "status") &&
  error.cause.response.status === 429

const rateLimitRetry = Schedule.max([Schedule.exponential("500 millis", 2).pipe(Schedule.jittered), Schedule.recurs(5)])
  .pipe(Schedule.while<StellarIndexerError, Duration.Duration>(({ input }) => isRateLimitError(input)))

/**
 * Builds a `StellarIndexer` for one network.
 *
 * - `confirmations` overrides `defaultConfirmations(network)`.
 * - `limit` is the `getEvents` page size (default 1000, the RPC accepts up to 10000).
 *
 * @since 0.1.0
 * @category layers
 */
export const layer = (options: {
  readonly network: StellarNetwork
  readonly rpcUrl: string
  readonly confirmations?: number | undefined
  readonly limit?: number | undefined
}): Layer.Layer<StellarIndexer> =>
  Layer.sync(StellarIndexer, () => {
    const server = new rpc.Server(options.rpcUrl)
    const confirmations = BigInt(options.confirmations ?? defaultConfirmations(options.network))
    const limit = options.limit ?? 1000

    const call = <A>(reason: string, f: () => Promise<A>) =>
      Effect.tryPromise({ try: f, catch: StellarIndexerError.fromCause(reason) }).pipe(Effect.retry(rateLimitRetry))

    const decode = <S extends Schema.Top>(schema: S, reason: string) => (u: unknown) =>
      Schema.decodeUnknownEffect(schema)(u).pipe(Effect.mapError(StellarIndexerError.fromCause(reason)))

    const lastConfirmedBlock = call("failed to get the latest ledger", () => server.getHealth()).pipe(
      Effect.map(({ latestLedger }) => {
        const block = BigInt(latestLedger) - confirmations
        return block < BigInt(0) ? BigInt(0) : block
      }),
      Effect.withSpan("StellarIndexer.lastConfirmedBlock")
    )

    const fetchEvents = Effect.fn("StellarIndexer.fetchEvents")(function*({ address, fromBlock, toBlock }: {
      readonly address: StellarContractAddress
      readonly fromBlock: bigint
      readonly toBlock: bigint
    }) {
      if (fromBlock > toBlock) return []
      const { oldestLedger } = yield* call("failed to get the RPC retention window", () => server.getHealth())
      if (fromBlock < BigInt(oldestLedger)) {
        return yield* new StellarIndexerError({
          reason:
            `fromBlock ${fromBlock} is older than the RPC's oldest retained ledger ${oldestLedger}: getEvents only serves recent ledgers`,
          cause: { fromBlock, oldestLedger }
        })
      }

      const filters: Array<rpc.Api.EventFilter> = [{ type: "contract", contractIds: [address] }]
      const raw: Array<rpc.Api.RawEventResponse> = []
      let cursor: string | undefined
      while (true) {
        const page: rpc.Api.RawGetEventsResponse = yield* call("failed to get events", () =>
          cursor === undefined
            // endLedger is exclusive, and must be omitted once paging with a cursor
            ? server._getEvents({ filters, limit, startLedger: Number(fromBlock), endLedger: Number(toBlock) + 1 })
            : server._getEvents({ filters, limit, cursor }))
        const inRange = page.events.filter((event) => BigInt(event.ledger) <= toBlock)
        raw.push(...inRange)
        // shortcut: a short page is taken as the end of the range, which holds unless the RPC caps its scan window
        if (page.events.length < limit || inRange.length < page.events.length) break
        cursor = page.cursor
      }

      return yield* Effect.forEach(
        // contract events emitted by failed contract calls are reported with inSuccessfulContractCall: false
        raw.filter((event) => event.inSuccessfulContractCall !== false),
        (event) =>
          Effect.all({
            contractId: decode(StellarContractAddress, "invalid contract id in getEvents response")(event.contractId),
            transactionHash: decode(StellarTransactionHash, "invalid transaction hash in getEvents response")(
              event.txHash
            )
          }).pipe(Effect.map(({ contractId, transactionHash }): StellarContractEvent => ({
            id: event.id,
            contractId,
            topics: event.topic ?? [],
            value: event.value,
            blockNumber: BigInt(event.ledger),
            transactionHash,
            eventIndex: Number(event.id.split("-")[1]),
            ledgerClosedAt: event.ledgerClosedAt
          })))
      )
    })

    return StellarIndexer.of({ lastConfirmedBlock, fetchEvents })
  })
