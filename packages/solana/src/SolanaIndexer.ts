/**
 * @since 0.1.0
 */
import {
  address as toKitAddress,
  createSolanaRpc,
  isSolanaError,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR
} from "@solana/kit"
import type { Signature } from "@solana/kit"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import type { SolanaAddress } from "./SolanaAddress.ts"
import { defaultConfirmations, type SolanaNetwork } from "./SolanaNetwork.ts"
import { SolanaTransactionHash } from "./SolanaTransactionHash.ts"

/**
 * @since 0.1.0
 * @category Errors
 */
export class SolanaIndexerError extends Schema.TaggedError<SolanaIndexerError>()("SolanaIndexerError", {
  reason: Schema.String,
  cause: Schema.Defect()
}) {
  /**
   * @since 0.1.0
   */
  static fromCause = (reason: string) => (cause: unknown) => new SolanaIndexerError({ reason, cause })
}

/**
 * A transaction touching an indexed address, kept raw for later decoding.
 *
 * @since 0.1.0
 * @category Models
 */
export interface SolanaTransaction {
  readonly signature: SolanaTransactionHash
  /** The slot of the transaction. */
  readonly blockNumber: bigint
  /** Unix timestamp in seconds, when the node knows it. */
  readonly blockTime: bigint | null
  /** Position among the indexed address's transactions in the same slot, in execution order. */
  readonly index: number
  /** Whether the transaction failed (its fee was still paid). */
  readonly err: boolean
  /** The signed wire transaction, base64-encoded. */
  readonly transaction: string
  /** The RPC transaction status meta (balances, logs, inner instructions), with u64 values as decimal strings. */
  readonly meta: Schema.Json
}

/**
 * @since 0.1.0
 * @category Services
 */
export class SolanaIndexer extends Context.Service<SolanaIndexer, {
  readonly lastConfirmedBlock: Effect.Effect<bigint, SolanaIndexerError>
  readonly fetchTransactions: (params: {
    readonly address: SolanaAddress
    readonly fromBlock: bigint
    readonly toBlock: bigint
  }) => Effect.Effect<ReadonlyArray<SolanaTransaction>, SolanaIndexerError>
}>()("@effect-blockchain/solana/SolanaIndexer") {}

// Maximum `limit` accepted by `getSignaturesForAddress`.
const PAGE_SIZE = 1000

const isRateLimited = (error: SolanaIndexerError): boolean =>
  isSolanaError(error.cause, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR) && error.cause.context.statusCode === 429

const rateLimitRetry = Schedule.max([Schedule.exponential("500 millis").pipe(Schedule.jittered), Schedule.recurs(5)])

const call = <A>(reason: string, send: () => Promise<A>): Effect.Effect<A, SolanaIndexerError> =>
  Effect.tryPromise({ try: send, catch: SolanaIndexerError.fromCause(reason) }).pipe(
    Effect.retry({ schedule: rateLimitRetry, while: isRateLimited })
  )

const toJson = (value: unknown): Schema.Json =>
  JSON.parse(JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v))

/**
 * Builds a `SolanaIndexer` reading the cluster at `confirmed` commitment.
 *
 * `lastConfirmedBlock` is the `confirmed` slot minus `confirmations` (default: `defaultConfirmations(network)`).
 *
 * @since 0.1.0
 * @category Layers
 */
export const layer = (options: {
  readonly network: SolanaNetwork
  readonly rpcUrl: string
  readonly confirmations?: number | undefined
}): Layer.Layer<SolanaIndexer> =>
  Layer.sync(SolanaIndexer, () => {
    const rpc = createSolanaRpc(options.rpcUrl)
    const confirmations = BigInt(options.confirmations ?? defaultConfirmations(options.network))

    const lastConfirmedBlock = call(
      "SolanaIndexer.lastConfirmedBlock: failed to get slot",
      () => rpc.getSlot({ commitment: "confirmed" }).send()
    ).pipe(Effect.map((slot) => slot > confirmations ? slot - confirmations : BigInt(0)))

    const fetchTransactions = Effect.fn("SolanaIndexer.fetchTransactions")(function*({ address, fromBlock, toBlock }: {
      readonly address: SolanaAddress
      readonly fromBlock: bigint
      readonly toBlock: bigint
    }) {
      // Signatures come newest first: page backwards from the head until a page reaches below `fromBlock`.
      const entries: Array<{ signature: Signature; slot: bigint; blockTime: bigint | null; failed: boolean }> = []
      let before: Signature | undefined
      while (true) {
        const page = yield* call(
          "SolanaIndexer.fetchTransactions: failed to get signatures",
          () =>
            rpc.getSignaturesForAddress(toKitAddress(address), {
              limit: PAGE_SIZE,
              commitment: "confirmed",
              ...(before ? { before } : {})
            }).send()
        )
        for (const entry of page) {
          if (entry.slot >= fromBlock && entry.slot <= toBlock) {
            entries.push({
              signature: entry.signature,
              slot: entry.slot,
              blockTime: entry.blockTime,
              failed: entry.err !== null
            })
          }
        }
        const last = page.at(-1)
        if (page.length < PAGE_SIZE || last === undefined || last.slot < fromBlock) break
        before = last.signature
      }
      entries.reverse()
      const indexes: Array<number> = []
      entries.forEach((entry, i) => indexes.push(entries[i - 1]?.slot === entry.slot ? indexes[i - 1] + 1 : 0))

      return yield* Effect.forEach(entries, (entry, i) =>
        Effect.gen(function*() {
          const signature = yield* Schema.decodeUnknownEffect(SolanaTransactionHash)(entry.signature).pipe(
            Effect.mapError(SolanaIndexerError.fromCause("SolanaIndexer.fetchTransactions: invalid signature"))
          )
          const tx = yield* call(
            `SolanaIndexer.fetchTransactions: failed to get transaction ${signature}`,
            () =>
              rpc.getTransaction(entry.signature, {
                encoding: "base64",
                maxSupportedTransactionVersion: 0,
                commitment: "confirmed"
              }).send()
          )
          if (tx === null) {
            return yield* new SolanaIndexerError({
              reason: `SolanaIndexer.fetchTransactions: transaction ${signature} not found`,
              cause: null
            })
          }
          return {
            signature,
            blockNumber: entry.slot,
            blockTime: entry.blockTime,
            index: indexes[i],
            err: entry.failed,
            transaction: tx.transaction[0],
            meta: toJson(tx.meta)
          }
        }))
    })

    return SolanaIndexer.of({ lastConfirmedBlock, fetchTransactions })
  })
