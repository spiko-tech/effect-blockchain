/**
 * The confirmation rules shared by the `@effect-blockchain` chain packages: the last confirmed block under a head and
 * the wait for a transaction to reach a final status.
 *
 * @since 0.2.0
 */
import * as BigInt_ from "effect/BigInt"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schedule from "effect/Schedule"
import * as JsonRpc from "./JsonRpc.ts"

/**
 * The default interval between two reads of the head or of a transaction status: 10 seconds.
 *
 * @since 0.2.0
 * @category constants
 */
export const DEFAULT_POLL_INTERVAL: Duration.Duration = Duration.seconds(10)

/**
 * `head` minus `confirmations`, never below 0.
 *
 * @since 0.2.0
 * @category confirmations
 */
export const lastConfirmedBlock = (head: bigint, confirmations: number): bigint =>
  BigInt_.max(head - BigInt(confirmations), BigInt(0))

/**
 * Reads `fetch` on `poll` (`Schedule.spaced(DEFAULT_POLL_INTERVAL)` by default) until `isFinal` holds, and returns
 * that status. A read failing with a transient reason ({@link JsonRpc.isTransient}) is read again on `poll`, any
 * other error fails the wait. A `poll` that ends first returns the last read, a status or a transient error.
 *
 * @since 0.2.0
 * @category confirmations
 */
export const awaitConfirmation = <A, E extends { readonly reason: JsonRpc.Reason }, R>(options: {
  readonly fetch: Effect.Effect<A, E, R>
  readonly isFinal: (status: A) => boolean
  readonly poll?: Schedule.Schedule<unknown> | undefined
}): Effect.Effect<A, E, R> =>
  options.fetch.pipe(
    Effect.result,
    Effect.flatMap((read) =>
      Result.isFailure(read) && !JsonRpc.isTransient(read.failure.reason)
        ? Effect.fail(read.failure)
        : Effect.succeed(read)
    ),
    Effect.repeat({
      schedule: options.poll ?? Schedule.spaced(DEFAULT_POLL_INTERVAL),
      until: (read) => Result.isSuccess(read) && options.isFinal(read.success)
    }),
    Effect.flatMap(Effect.fromResult)
  )
