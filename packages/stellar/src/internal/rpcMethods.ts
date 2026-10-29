import * as Schema from "effect/Schema"
import { StellarContractAddress } from "../StellarAddress.ts"
import { StellarContractEvent } from "../StellarContractEvent.ts"
import { LedgerFromNumber } from "./LedgerFromNumber.ts"

/**
 * A Stellar RPC method: its name, the codec of its named params (`undefined`: no `params` member is sent) and the
 * codec of its result.
 *
 * @internal
 */
export interface RpcMethod<Params, Result> {
  readonly name: string
  readonly params: Schema.Codec<Params, Schema.JsonObject | undefined>
  readonly result: Schema.Codec<Result, Schema.Json>
}

const make = <Params, Result>(method: RpcMethod<Params, Result>): RpcMethod<Params, Result> => method

const NoParams = Schema.Undefined

/**
 * An RPC paging cursor or event id: a 19-digit TOID and a 10-digit event index.
 *
 * @internal
 */
export const Cursor = Schema.String.check(Schema.isPattern(/^\d{19}-\d{10}$/u))

/** @internal */
export const getNetwork = make({
  name: "getNetwork",
  params: NoParams,
  result: Schema.Struct({ passphrase: Schema.String, protocolVersion: Schema.Int })
})

/** @internal */
export const getLatestLedger = make({
  name: "getLatestLedger",
  params: NoParams,
  result: Schema.Struct({ id: Schema.String, protocolVersion: Schema.Int, sequence: LedgerFromNumber })
})

/** @internal */
export const getHealth = make({
  name: "getHealth",
  params: NoParams,
  result: Schema.Struct({ latestLedger: LedgerFromNumber, oldestLedger: LedgerFromNumber })
})

/** @internal */
export const getEvents = make({
  name: "getEvents",
  params: Schema.Struct({
    // `endLedger` is exclusive, and both bounds must be left out when paging with a cursor
    startLedger: Schema.optionalKey(LedgerFromNumber),
    endLedger: Schema.optionalKey(LedgerFromNumber),
    filters: Schema.Array(Schema.Struct({
      type: Schema.Literal("contract"),
      contractIds: Schema.Array(StellarContractAddress),
      topics: Schema.optionalKey(Schema.Array(Schema.Array(Schema.String)))
    })),
    pagination: Schema.Struct({ cursor: Schema.optionalKey(Cursor), limit: Schema.Int })
  }),
  result: Schema.Struct({ events: Schema.Array(StellarContractEvent), cursor: Cursor, latestLedger: LedgerFromNumber })
})
