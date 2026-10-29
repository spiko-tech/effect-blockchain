/**
 * Soroban contract events, as returned by Stellar RPC `getEvents`.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import { identity } from "effect/Function"
import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"
import { LedgerFromNumber } from "./internal/LedgerFromNumber.ts"
import { StellarContractAddress } from "./StellarAddress.ts"
import { StellarTransactionHash } from "./StellarTransactionHash.ts"

// the RPC sends the hash without `0x`: encode back to that shape
const RpcTransactionHash = Schema.String.pipe(
  Schema.decodeTo(
    StellarTransactionHash,
    SchemaTransformation.transform({ decode: identity, encode: (hash: string) => hash.replace(/^0x/u, "") })
  )
)

/**
 * A contract event, decoded from the raw `getEvents` event. The encoded side is the RPC shape (`ledger`, `txHash`,
 * `topic`), the decoded side uses the names shared with the other chains (`blockNumber`, `transactionHash`, `topics`).
 *
 * - `id` is the RPC event id, a 19-digit TOID and a 10-digit event index: sorting ids as strings gives chain order.
 * - `topics` and `value` are base64 XDR `ScVal`s, left undecoded. The RPC omits `topic` when empty.
 * - `inSuccessfulContractCall` is kept raw: filtering out events of failed calls is the indexer's job. Stellar RPC
 *   stopped sending it once it was always `true` (protocol 23 no longer emits events of failed calls), so a missing
 *   field decodes to `true`.
 *
 * @since 0.1.0
 * @category schemas
 */
export const StellarContractEvent = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^\d{19}-\d{10}$/u)),
  type: Schema.Literals(["contract", "system", "diagnostic"]),
  contractId: StellarContractAddress,
  topics: Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  value: Schema.String,
  blockNumber: LedgerFromNumber,
  ledgerClosedAt: Schema.String,
  transactionHash: RpcTransactionHash,
  inSuccessfulContractCall: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true)))
}).pipe(
  Schema.encodeKeys({ topics: "topic", blockNumber: "ledger", transactionHash: "txHash" }),
  Schema.annotate({ identifier: "StellarContractEvent", title: "Stellar contract event" })
)

/**
 * @since 0.1.0
 * @category models
 */
export type StellarContractEvent = typeof StellarContractEvent.Type
