import type * as JsonRpc from "@effect-blockchain/core/JsonRpc"
import * as Schema from "effect/Schema"
import { StellarContractAddress } from "../StellarAddress.ts"
import { StellarContractEvent } from "../StellarContractEvent.ts"
import { LedgerFromNumber } from "./LedgerFromNumber.ts"

const make = <Params, A>(method: JsonRpc.Method<Params, A>): JsonRpc.Method<Params, A> => method

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

/** @internal */
export const getLedgers = make({
  name: "getLedgers",
  params: Schema.Struct({
    startLedger: LedgerFromNumber,
    pagination: Schema.Struct({ limit: Schema.optionalKey(Schema.Int) })
  }),
  result: Schema.Struct({
    ledgers: Schema.Array(
      Schema.Struct({ sequence: LedgerFromNumber, closeTime: Schema.FiniteFromString, metadataXdr: Schema.String })
        .pipe(
          Schema.encodeKeys({ closeTime: "ledgerCloseTime" })
        )
    ),
    latestLedger: LedgerFromNumber
  })
})

/** @internal */
export const getLedgerEntries = make({
  name: "getLedgerEntries",
  params: Schema.Struct({ keys: Schema.Array(Schema.String) }),
  result: Schema.Struct({
    entries: Schema.Array(
      Schema.Struct({ xdr: Schema.String, lastModifiedLedger: LedgerFromNumber }).pipe(
        Schema.encodeKeys({ lastModifiedLedger: "lastModifiedLedgerSeq" })
      )
    ),
    latestLedger: LedgerFromNumber
  })
})
