/**
 * Reads the Soroban events of a set of contracts and the native (XLM) balance of an account over confirmed ledgers,
 * on top of {@link StellarRpc}, once or as a stream following the confirmed head. Events older than a regular
 * endpoint's retention are read from the ledgers of the archive endpoints. The stream options are described in
 * [Concepts](https://github.com/spiko-tech/effect-blockchain/blob/main/docs/concepts.md#indexer-streams).
 *
 * An event range is split into ranges of at most `maxBlockRange` ledgers, each paged with `getEvents`, and
 * `contractIds` into groups of 5, the RPC limit per filter (`MaxContractIDsLimit` in
 * https://github.com/stellar/go-stellar-sdk/blob/main/protocols/rpc/get_events.go). A page after a cursor is only
 * served by the endpoint that issued the cursor, so when it fails the group restarts once from its first page. Stellar
 * RPC keeps no past balances: a balance is read from the account entry at the head, then back through the `getLedgers`
 * meta of each ledger that changed the account since.
 *
 * @example
 * ```ts
 * import * as StellarIndexer from "@effect-blockchain/stellar/StellarIndexer"
 * import * as StellarRpc from "@effect-blockchain/stellar/StellarRpc"
 * import * as Config from "effect/Config"
 * import * as Effect from "effect/Effect"
 * import * as FetchHttpClient from "effect/http/FetchHttpClient"
 * import * as Layer from "effect/Layer"
 * import * as Stream from "effect/Stream"
 *
 * declare const filter: Omit<StellarIndexer.StellarIndexerFilter, "fromBlock" | "toBlock">
 * declare const cursor: bigint
 * declare const save: (ledger: bigint) => Effect.Effect<void>
 *
 * const program = Effect.gen(function*() {
 *   const rpc = yield* StellarRpc.StellarRpc
 *   const indexer = yield* StellarIndexer.StellarIndexer
 *   yield* Effect.log(`head: ${(yield* rpc.getLatestLedger).sequence}`)
 *   yield* indexer.streamEvents({ filter, fromBlock: cursor + BigInt(1) }).pipe(
 *     Stream.runForEach((batch) => save(batch.toBlock))
 *   )
 * })
 *
 * const RpcLive = StellarRpc.layerConfig({
 *   network: Config.succeed("Stellar"),
 *   endpoints: Config.all([Config.all({ name: Config.succeed("main"), url: Config.Redacted("STELLAR_RPC_URL") })])
 * })
 *
 * const main = program.pipe(
 *   Effect.provide(StellarIndexer.layer().pipe(Layer.provideMerge(RpcLive), Layer.provide(FetchHttpClient.layer)))
 * )
 * ```
 *
 * @since 0.1.0
 */
import * as Confirmations from "@effect-blockchain/core/Confirmations"
import * as JsonRpc from "@effect-blockchain/core/JsonRpc"
import { Keypair, StrKey, xdr } from "@stellar/stellar-sdk"
import * as Arr from "effect/Array"
import * as BigInt_ from "effect/BigInt"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Order from "effect/Order"
import * as Schedule from "effect/Schedule"
import * as Stream from "effect/Stream"
import { accountBefore, accountChange, accountEntry } from "./internal/accountChange.ts"
import { ledgerEvents, matchesTopics } from "./internal/ledgerEvents.ts"
import type { StellarAccountAddress } from "./StellarAddress.ts"
import type { StellarContractEvent } from "./StellarContractEvent.ts"
import * as StellarNetwork from "./StellarNetwork.ts"
import type { StellarEventsCursor, StellarEventsFilter, StellarLedger } from "./StellarRpc.ts"
import { StellarRpc, StellarRpcError } from "./StellarRpc.ts"

/**
 * The default `maxBlockRange`: 10000 ledgers, the most a Stellar RPC scans per request (`LedgerScanLimit` in
 * https://github.com/stellar/stellar-rpc/blob/main/cmd/stellar-rpc/internal/methods/get_events.go).
 *
 * @since 0.1.0
 * @category constants
 */
export const DEFAULT_MAX_BLOCK_RANGE = 10_000

/**
 * A {@link StellarEventsFilter} without its paging fields (`limit`, `cursor`), over the inclusive ledger range
 * `[fromBlock, toBlock]`. `contractIds` has no size limit here.
 *
 * @since 0.1.0
 * @category models
 */
export type StellarIndexerFilter = Omit<StellarEventsFilter, "limit" | "cursor">

/**
 * The events of the ledgers `[fromBlock, toBlock]` (both inclusive), in chain order, emitted by
 * {@link StellarIndexer.Service.streamEvents}.
 *
 * A batch is emitted for every range, even without events. Delivery is at-least-once: save `batch.toBlock` once the
 * batch is handled and resume from `toBlock + 1`. RPC nodes keep about 7 days of ledgers: an older `fromBlock` fails
 * the stream with `Pruned`.
 *
 * @since 0.1.0
 * @category models
 */
export interface StellarIndexerBatch {
  readonly fromBlock: bigint
  readonly toBlock: bigint
  readonly events: ReadonlyArray<StellarContractEvent>
}

/**
 * The {@link StellarIndexer.Service.streamEvents} options.
 *
 * @since 0.1.0
 * @category models
 */
export interface StellarIndexerStreamOptions {
  readonly filter: Omit<StellarIndexerFilter, "fromBlock" | "toBlock">
  readonly fromBlock: bigint
  /** The stream ends after the batch reaching it, and is empty when `fromBlock > toBlock`. */
  readonly toBlock?: bigint | undefined
  /**
   * When to read the head again once caught up, `Schedule.spaced(DEFAULT_POLL_INTERVAL)` by default. It restarts after
   * each batch, and its end ends the stream: `Schedule.recurs(0)` drains to the head and stops.
   */
  readonly poll?: Schedule.Schedule<unknown> | undefined
  /** Retries a step failing with a transient reason ({@link JsonRpc.isTransient}) at the same ledger. Off by default. */
  readonly retry?: Schedule.Schedule<unknown, StellarRpcError> | undefined
}

/**
 * The ledgers per `getLedgers` page: 10, each ledger meta being 1 to 3 MB on mainnet.
 *
 * @since 0.3.0
 * @category constants
 */
export const LEDGERS_PAGE_SIZE = 10

/**
 * The {@link StellarIndexer.Service.fetchArchivedEvents} options, over the inclusive ledger range `[fromBlock, toBlock]`.
 *
 * @since 0.3.0
 * @category models
 */
export interface StellarIndexerArchivedEventsOptions {
  readonly filter: Omit<StellarIndexerFilter, "fromBlock" | "toBlock">
  readonly fromBlock: bigint
  readonly toBlock: bigint
  /** Pages of {@link LEDGERS_PAGE_SIZE} ledgers read at once, 1 by default. Each holds up to 30 MB of metas. */
  readonly concurrency?: number | undefined
  /** Retries a page failing with a transient reason ({@link JsonRpc.isTransient}). Off by default. */
  readonly retry?: Schedule.Schedule<unknown, StellarRpcError> | undefined
}

/**
 * The native balance of an account at the end of a ledger, in stroops, emitted by
 * {@link StellarIndexer.Service.streamNativeBalance}.
 *
 * @since 0.2.0
 * @category models
 */
export interface StellarNativeBalance {
  readonly block: bigint
  readonly balance: bigint
}

/**
 * The {@link StellarIndexer.Service.streamNativeBalance} options: a sample at `fromBlock`, `fromBlock + step`,
 * `fromBlock + 2 * step`... up to `toBlock`. `poll` and `retry` work as in {@link StellarIndexerStreamOptions}.
 *
 * @since 0.2.0
 * @category models
 */
export interface StellarIndexerNativeBalanceOptions {
  readonly address: StellarAccountAddress
  readonly fromBlock: bigint
  /** The stream ends after the last sample not above it, and is empty when `fromBlock > toBlock`. */
  readonly toBlock?: bigint | undefined
  /** Ledgers between two samples, a positive safe integer. */
  readonly step: number
  /** The `archive` option of {@link StellarIndexer.Service.fetchNativeBalance}, for the first sample only. */
  readonly archive?: boolean | undefined
  readonly poll?: Schedule.Schedule<unknown> | undefined
  readonly retry?: Schedule.Schedule<unknown, StellarRpcError> | undefined
}

/**
 * @since 0.1.0
 * @category services
 */
export class StellarIndexer extends Context.Service<StellarIndexer, {
  /** The latest ledger minus the configured confirmations, never below 0. */
  readonly lastConfirmedBlock: Effect.Effect<bigint, StellarRpcError>
  /**
   * Every contract event matching `filter`, in chain order (event id order). Events of failed contract calls
   * (`inSuccessfulContractCall: false`) are dropped. `fromBlock > toBlock` returns no events. Costs one `getEvents`
   * request per page of results, and at least one per `maxBlockRange` ledgers and group of 5 contracts. `retry`
   * retries a request failing with a transient reason ({@link JsonRpc.isTransient}), and is off by default.
   */
  readonly fetchEvents: (
    filter: StellarIndexerFilter,
    options?: { readonly retry?: Schedule.Schedule<unknown, StellarRpcError> | undefined }
  ) => Effect.Effect<ReadonlyArray<StellarContractEvent>, StellarRpcError>
  /**
   * The events matching `filter` from `fromBlock` on, in batches of at most `maxBlockRange` confirmed ledgers,
   * following the confirmed head.
   */
  readonly streamEvents: (options: StellarIndexerStreamOptions) => Stream.Stream<StellarIndexerBatch, StellarRpcError>
  /**
   * The events `fetchEvents` returns for `filter`, ids included, decoded from the `getLedgers` metas of the endpoints
   * flagged `archive`, for ledgers a regular endpoint no longer retains. Every ledger of the range is downloaded (1 to
   * 3 MB each on mainnet) and the range is returned as one batch. `fromBlock > toBlock` returns no events.
   */
  readonly fetchArchivedEvents: (
    options: StellarIndexerArchivedEventsOptions
  ) => Effect.Effect<StellarIndexerBatch, StellarRpcError>
  /**
   * The native balance of `address` at the end of `block`, in stroops, read from the account entry at the head, then
   * back through the `getLedgers` meta of each ledger that changed the account after `block`. An account missing at
   * the head reads `0`, even if it was merged after `block`. Costs one `getLedgerEntries` request, plus one `getLedgers`
   * request for a single ledger (1 to 3 MB on mainnet) per ledger that changed the account after `block`, from an
   * endpoint flagged `archive` for a ledger the regular endpoints no longer retain. `retry` retries a request failing
   * with a transient reason ({@link JsonRpc.isTransient}), and is off by default.
   */
  readonly fetchNativeBalance: (
    options: {
      readonly address: StellarAccountAddress
      readonly block: bigint
      /**
       * Reads each ledger that changed the account from the endpoints flagged `archive` only, with one archive request
       * per change after `block` and none to the regular endpoints, and fails `Rejected` when no endpoint is flagged
       * `archive`. Off by default: a ledger goes to the archive endpoints once a regular endpoint fails `Pruned`.
       */
      readonly archive?: boolean | undefined
      readonly retry?: Schedule.Schedule<unknown, StellarRpcError> | undefined
    }
  ) => Effect.Effect<bigint, StellarRpcError>
  /**
   * The native balance of `address` at every `step` ledgers from `fromBlock` on, following the confirmed head. The
   * first sample is read like `fetchNativeBalance`. A later sample reads the account entry at the head, unless an
   * earlier read already covers it, and when the account changed since the sample, every ledger since the previous
   * sample with `getLedgers` (1 to 3 MB each on mainnet): `step` does not reduce these history reads.
   */
  readonly streamNativeBalance: (
    options: StellarIndexerNativeBalanceOptions
  ) => Stream.Stream<StellarNativeBalance, StellarRpcError>
}>()("@effect-blockchain/stellar/StellarIndexer") {}

/**
 * The default `poll` spacing of {@link StellarIndexer.Service.streamEvents}: 10 seconds.
 *
 * @since 0.1.0
 * @category constants
 */
export const DEFAULT_POLL_INTERVAL: Duration.Duration = Confirmations.DEFAULT_POLL_INTERVAL

const MAX_CONTRACT_IDS = 5

const byId = Order.mapInput(Order.String, (event: StellarContractEvent) => event.id)

// a balance that holds from the ledger it was read at until `until`
interface KnownBalance {
  readonly balance: bigint
  readonly until: bigint
}

// the next sample, the confirmed head last read, and the balance read at the previous sample
interface BalancePosition {
  readonly block: bigint
  readonly head: bigint
  readonly known: Option.Option<KnownBalance>
}

// the confirmed ledgers [next, head] not indexed yet, empty once the stream reaches the head it last read
interface StreamPosition {
  readonly next: bigint
  readonly head: bigint
}

/**
 * Builds a {@link StellarIndexer} over the provided {@link StellarRpc}.
 *
 * - `confirmations`: ledgers kept behind the latest one, default `StellarNetwork.defaultConfirmations` of the
 *   RPC's network.
 * - `maxBlockRange`: ledgers per range, a positive integer, default {@link DEFAULT_MAX_BLOCK_RANGE}.
 * - `limit`: `getEvents` page size, default 1000, at most 10000.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer = (options: {
  readonly confirmations?: number | undefined
  readonly maxBlockRange?: number | undefined
  readonly limit?: number | undefined
} = {}): Layer.Layer<StellarIndexer, never, StellarRpc> =>
  Layer.effect(
    StellarIndexer,
    Effect.gen(function*() {
      const rpc = yield* StellarRpc
      const maxBlockRange = options.maxBlockRange ?? DEFAULT_MAX_BLOCK_RANGE
      if (!Number.isSafeInteger(maxBlockRange) || maxBlockRange < 1) {
        return yield* Effect.die(new RangeError(`maxBlockRange must be a positive integer, got ${maxBlockRange}`))
      }
      const range = BigInt(maxBlockRange)
      const pageSize = BigInt(LEDGERS_PAGE_SIZE)
      const { limit } = options

      const confirmations = options.confirmations ?? StellarNetwork.defaultConfirmations(rpc.network)
      const lastConfirmedBlock = rpc.getLatestLedger.pipe(
        Effect.map((ledger) => Confirmations.lastConfirmedBlock(ledger.sequence, confirmations)),
        Effect.withSpan("StellarIndexer.lastConfirmedBlock")
      )
      // `effect` retried with `retry` while it fails with a transient reason
      const retrying = <A>(
        effect: Effect.Effect<A, StellarRpcError>,
        retry: Schedule.Schedule<unknown, StellarRpcError> | undefined
      ) =>
        retry === undefined
          ? effect
          : Effect.retry(effect, { schedule: retry, while: (error) => JsonRpc.isTransient(error.reason) })

      const fetchEvents = Effect.fn("StellarIndexer.fetchEvents")((
        filter: StellarIndexerFilter,
        options?: { readonly retry?: Schedule.Schedule<unknown, StellarRpcError> | undefined }
      ) => {
        if (filter.fromBlock > filter.toBlock) return Effect.succeed([])
        const groups = Arr.chunksOf(filter.contractIds, MAX_CONTRACT_IDS)
        const starts = Arr.makeBy(
          Number((filter.toBlock - filter.fromBlock) / range) + 1,
          (i) => filter.fromBlock + BigInt(i) * range
        )
        return Effect.forEach(starts, (fromBlock) => {
          const toBlock = BigInt_.min(fromBlock + range - BigInt(1), filter.toBlock)
          return Effect.forEach(groups, (contractIds) => {
            const group = { ...filter, contractIds, fromBlock, toBlock, limit }
            // a cursor page has no fallback: when it fails, the group restarts once from its first page
            return Stream.paginate(
              Option.none<StellarEventsCursor>(),
              (cursor) =>
                retrying(rpc.getEvents({ ...group, cursor: Option.getOrUndefined(cursor) }), options?.retry).pipe(
                  Effect.mapBoth({
                    onFailure: (error) => Option.isNone(cursor) ? error : { cursorPage: error },
                    onSuccess: (page) =>
                      [page.events, Option.map(Option.fromUndefinedOr(page.cursor), Option.some)] as const
                  })
                )
            ).pipe(
              Stream.runCollect,
              Effect.retry({ times: 1, while: (error) => "cursorPage" in error }),
              Effect.mapError((error) => "cursorPage" in error ? error.cursorPage : error)
            )
          }).pipe(Effect.map((found) => groups.length > 1 ? Arr.sort(Arr.flatten(found), byId) : Arr.flatten(found)))
        }).pipe(Effect.map((ranges) => Arr.flatten(ranges).filter((event) => event.inSuccessfulContractCall)))
      })

      // one `getLedgers` page: from the archive endpoints only with `archive`, else from the regular ones and, once
      // one of them fails `Pruned`, from the archive ones; with no archive endpoint, the regular error stands. The
      // fallback reports a transient reason over `Pruned`, so `Pruned` is looked for in every endpoint's error.
      const ledgersPage = (startLedger: bigint, limit: number, archive: boolean) =>
        archive
          ? rpc.getLedgers({ startLedger, limit, archive })
          : rpc.getLedgers({ startLedger, limit }).pipe(Effect.catchIf(
            (error) =>
              JsonRpc.errorsOf(error).some((each) => each instanceof StellarRpcError && each.reason._tag === "Pruned"),
            (pruned) =>
              rpc.getLedgers({ startLedger, limit, archive: true }).pipe(Effect.catchIf(
                (error) => error.reason._tag === "Rejected" && error.endpoint === "archive",
                () => Effect.fail(pruned)
              ))
          ))

      // what `read` finds in each of the ledgers [from, to], in chain order, a page at a time
      const readLedgers = <A>(
        from: bigint,
        to: bigint,
        read: (ledger: StellarLedger) => ReadonlyArray<A>,
        archive = false
      ) =>
        Stream.paginate(from, (start) =>
          ledgersPage(start, Number(BigInt_.min(pageSize, to - start + BigInt(1))), archive).pipe(
            Effect.map(({ ledgers }) => {
              const next = start + BigInt(ledgers.length)
              return [ledgers.flatMap(read), next <= to ? Option.some(next) : Option.none()] as const
            })
          ))

      // the changes of `address` in the ledgers [from, to], in chain order
      const changes = (address: StellarAccountAddress, from: bigint, to: bigint) => {
        const read = (ledger: StellarLedger) =>
          Option.toArray(
            Option.map(accountChange(ledger.metadataXdr, address), (change) => ({ ...change, ledger: ledger.sequence }))
          )
        return readLedgers(from, to, read)
      }

      // the account entry of `address` at the head, from an endpoint that has reached `block`; a malformed entry is a defect
      const account = (address: StellarAccountAddress, block: bigint) => {
        const key = xdr.LedgerKey.account(
          new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(address).xdrAccountId() })
        ).toXdr("base64")
        return Effect.map(rpc.getLedgerEntries({ keys: [key], minLedger: block }), ({ entries, latestLedger }) => {
          const entry = entries[0]
          if (entry === undefined) {
            return { account: undefined, latestLedger }
          }
          const data = accountEntry(entry.xdr)
          if (StrKey.encodeEd25519PublicKey(data.accountId.ed25519.toBytes()) !== address) {
            throw new Error(`getLedgerEntries returned another account than ${address}`)
          }
          return { account: { balance: data.balance, lastModifiedLedger: entry.lastModifiedLedger }, latestLedger }
        })
      }

      // the balance at `block`, from the account entry at the head and back through each ledger that changed the account
      // after `block`: the account's first change in such a ledger is its state before it, which names the ledger of the
      // previous change, or its creation
      const balanceAt = (
        address: StellarAccountAddress,
        block: bigint,
        retry: Schedule.Schedule<unknown, StellarRpcError> | undefined,
        archive: boolean
      ): Effect.Effect<KnownBalance, StellarRpcError> => {
        const hop = (known: KnownBalance, ledger: bigint): Effect.Effect<KnownBalance, StellarRpcError> =>
          ledger <= block ? Effect.succeed(known) : Effect.flatMap(
            retrying(ledgersPage(ledger, 1, archive), retry),
            ({ cursor, ledgers }) => {
              const invalid = (message: string) =>
                Effect.fail(
                  new StellarRpcError({
                    reason: new JsonRpc.InvalidResponse(),
                    method: "getLedgers",
                    endpoint: cursor.endpoint,
                    cause: new Error(message)
                  })
                )
              const read = ledgers[0]
              const before = read?.sequence === ledger ? accountBefore(read.metadataXdr, address) : Option.none()
              if (Option.isNone(before)) {
                return invalid(`ledger ${ledger} does not change ${address}`)
              }
              const until = ledger - BigInt(1)
              if (before.value.created) {
                return Effect.succeed({ balance: BigInt(0), until })
              }
              if (before.value.lastModifiedLedger >= ledger) {
                return invalid(`ledger ${ledger} names ${before.value.lastModifiedLedger} as the previous change`)
              }
              return hop({ balance: before.value.balance, until }, before.value.lastModifiedLedger)
            }
          )
        return Effect.flatMap(
          retrying(account(address, block), retry),
          ({ account, latestLedger }) =>
            account === undefined
              ? Effect.succeed({ balance: BigInt(0), until: latestLedger })
              : hop({ balance: account.balance, until: latestLedger }, account.lastModifiedLedger)
        )
      }

      // the balance at `block` from the one known at an earlier sample
      const advance = (
        address: StellarAccountAddress,
        block: bigint,
        known: KnownBalance
      ): Effect.Effect<KnownBalance, StellarRpcError> =>
        block <= known.until ? Effect.succeed(known) : Effect.flatMap(
          account(address, block),
          ({ account, latestLedger }) =>
            account !== undefined && account.lastModifiedLedger <= block
              ? Effect.succeed({ balance: account.balance, until: latestLedger })
              : Stream.runLast(changes(address, known.until + BigInt(1), block)).pipe(Effect.map((last) => ({
                balance: Option.match(last, {
                  onNone: () =>
                    known.balance,
                  onSome: (change) =>
                    change.after
                }),
                until: block
              })))
        )

      return StellarIndexer.of({
        lastConfirmedBlock,
        fetchEvents,
        fetchArchivedEvents: Effect.fn("StellarIndexer.fetchArchivedEvents")(
          ({ concurrency = 1, filter, fromBlock, retry, toBlock }) => {
            if (fromBlock > toBlock) return Effect.succeed({ fromBlock, toBlock, events: [] })
            const pages = Number((toBlock - fromBlock) / pageSize) + 1
            const read = (ledger: StellarLedger) =>
              ledgerEvents(ledger, filter.contractIds).filter((event) => matchesTopics(filter.topics, event.topics))
            return Effect.forEach(
              Arr.makeBy(pages, (i) => fromBlock + BigInt(i) * pageSize),
              (start) =>
                retrying(
                  Stream.runCollect(readLedgers(start, BigInt_.min(start + pageSize - BigInt(1), toBlock), read, true)),
                  retry
                ),
              { concurrency }
            ).pipe(Effect.map((pages) => ({ fromBlock, toBlock, events: Arr.flatten(pages) })))
          }
        ),
        fetchNativeBalance: Effect.fn("StellarIndexer.fetchNativeBalance")((
          { address, archive = false, block, retry }
        ) => Effect.map(balanceAt(address, block, retry, archive), (known) => known.balance)),
        streamNativeBalance: (
          { address, archive = false, fromBlock, poll = Schedule.spaced(DEFAULT_POLL_INTERVAL), retry, step, toBlock }
        ) => {
          if (!Number.isSafeInteger(step) || step < 1) {
            return Stream.die(new RangeError(`step must be a positive integer, got ${step}`))
          }
          if (toBlock !== undefined && fromBlock > toBlock) return Stream.empty
          const stride = BigInt(step)
          const sample = (
            { block, head, known }: BalancePosition
          ): Effect.Effect<
            readonly [ReadonlyArray<StellarNativeBalance>, Option.Option<BalancePosition>],
            StellarRpcError
          > =>
            (block <= head
              ? Effect.succeed(head)
              : lastConfirmedBlock.pipe(Effect.repeat({ schedule: poll, until: (confirmed) => confirmed >= block })))
              .pipe(Effect.flatMap((confirmed) =>
                Option.match(known, {
                  // the whole sample is retried below
                  onNone: () => balanceAt(address, block, undefined, archive),
                  onSome: (known) => advance(address, block, known)
                }).pipe(Effect.map((next) => [
                  [{ block, balance: next.balance }],
                  toBlock !== undefined && block + stride > toBlock
                    ? Option.none()
                    : Option.some({ block: block + stride, head: confirmed, known: Option.some(next) })
                ]))
              ))
          return Stream.paginate(
            // a head below `fromBlock`: the first sample reads it
            { block: fromBlock, head: fromBlock - BigInt(1), known: Option.none() },
            (position: BalancePosition) => retrying(sample(position), retry)
          )
        },
        streamEvents: ({ filter, fromBlock, poll = Schedule.spaced(DEFAULT_POLL_INTERVAL), retry, toBlock }) => {
          if (toBlock !== undefined && fromBlock > toBlock) return Stream.empty
          // the head last read is reused while it covers `next` (the confirmed head only moves forward), else polled
          const step = (
            { head, next }: StreamPosition
          ): Effect.Effect<
            readonly [ReadonlyArray<StellarIndexerBatch>, Option.Option<StreamPosition>],
            StellarRpcError
          > =>
            (next <= head
              ? Effect.succeed(head)
              : lastConfirmedBlock.pipe(Effect.repeat({ schedule: poll, until: (confirmed) => confirmed >= next })))
              .pipe(Effect.flatMap((confirmed) => {
                const cap = toBlock === undefined ? confirmed : BigInt_.min(confirmed, toBlock)
                if (next > cap) return Effect.succeed([[], Option.none()])
                const end = BigInt_.min(next + range - BigInt(1), cap)
                return fetchEvents({ ...filter, fromBlock: next, toBlock: end }).pipe(Effect.map((events) => [
                  [{ fromBlock: next, toBlock: end, events }],
                  end === toBlock ? Option.none() : Option.some({ next: end + BigInt(1), head: confirmed })
                ]))
              }))
          return Stream.paginate(
            // a head below `fromBlock`: the first step reads it
            { next: fromBlock, head: fromBlock - BigInt(1) },
            (remaining) => retrying(step(remaining), retry)
          )
        }
      })
    })
  )

/**
 * Builds an {@link StellarIndexer} like {@link layer}, reading the options from `Config`.
 *
 * @example
 * ```ts
 * import * as StellarIndexer from "@effect-blockchain/stellar/StellarIndexer"
 * import * as Config from "effect/Config"
 *
 * const IndexerLive = StellarIndexer.layerConfig({ confirmations: Config.Int("STELLAR_CONFIRMATIONS") })
 * ```
 *
 * @since 0.1.0
 * @category layers
 */
export const layerConfig = (
  options: Config.Wrap<NonNullable<Parameters<typeof layer>[0]>>
): Layer.Layer<StellarIndexer, Config.ConfigError, StellarRpc> =>
  Layer.unwrap(Effect.map(Config.unwrap(options), layer))
