import { StrKey, xdr } from "@stellar/stellar-sdk"
import * as Option from "effect/Option"
import type { StellarAccountAddress } from "../StellarAddress.ts"

/**
 * An account's native balance before its first change and after its last change in one ledger, in stroops.
 *
 * @internal
 */
export interface AccountChange {
  readonly before: bigint
  readonly after: bigint
}

const applyChanges = (meta: xdr.TransactionMeta): ReadonlyArray<xdr.LedgerEntryChange> => {
  switch (meta.switch()) {
    case 0:
      return meta.operations().flatMap((operation) => operation.changes())
    case 1:
      return [...meta.v1().txChanges(), ...meta.v1().operations().flatMap((operation) => operation.changes())]
    default: {
      const v = meta.switch() === 2 ? meta.v2() : meta.switch() === 3 ? meta.v3() : meta.v4()
      return [
        ...v.txChangesBefore(),
        ...v.operations().flatMap((operation: xdr.OperationMeta | xdr.OperationMetaV2) => operation.changes()),
        ...v.txChangesAfter()
      ]
    }
  }
}

// stellar-core charges the fees of every transaction before applying any, then (protocol 23, `LedgerCloseMetaV2`)
// applies the Soroban fee refunds after all of them:
// https://github.com/stellar/stellar-xdr/blob/curr/Stellar-ledger.x (`TransactionResultMetaV1`)
const ledgerChanges = (meta: xdr.LedgerCloseMeta): ReadonlyArray<xdr.LedgerEntryChange> => {
  const txs: ReadonlyArray<xdr.TransactionResultMeta | xdr.TransactionResultMetaV1> = meta.switch() === 0
    ? meta.v0().txProcessing()
    : meta.switch() === 1
    ? meta.v1().txProcessing()
    : meta.v2().txProcessing()
  return [
    ...txs.flatMap((tx) => tx.feeProcessing()),
    ...txs.flatMap((tx) => applyChanges(tx.txApplyProcessing())),
    ...txs.flatMap((tx) => tx instanceof xdr.TransactionResultMetaV1 ? tx.postTxApplyFeeProcessing() : [])
  ]
}

const accountIdOf = (change: xdr.LedgerEntryChange): Buffer | undefined => {
  if (change.switch().name === "ledgerEntryRemoved") {
    const key = change.removed()
    return key.switch().name === "account" ? key.account().accountId().ed25519() : undefined
  }
  const data = change.value()
  return data instanceof xdr.LedgerEntry && data.data().switch().name === "account"
    ? data.data().account().accountId().ed25519()
    : undefined
}

// a removed account (merged) holds nothing, and a created one held nothing before
const balanceOf = (change: xdr.LedgerEntryChange, missing: string): bigint => {
  const data = change.value()
  return change.switch().name === missing || !(data instanceof xdr.LedgerEntry)
    ? BigInt(0)
    : BigInt(data.data().account().balance().toString())
}

/**
 * The native balance of `address` around its changes in a ledger, from the base64 XDR `LedgerCloseMeta` of
 * `getLedgers` (versions 0 to 2, fee processing, operations and Soroban fee refunds, fee-bump fee sources included).
 * `None` when the ledger does not change the account. Throws on a malformed meta.
 *
 * @internal
 */
export const accountChange = (metadataXdr: string, address: StellarAccountAddress): Option.Option<AccountChange> => {
  const bytes = Buffer.from(metadataXdr, "base64")
  const accountId = StrKey.decodeEd25519PublicKey(address)
  // every change of the account carries its id verbatim: most ledgers are skipped without decoding (1 to 3 MB)
  if (!bytes.includes(accountId)) return Option.none()
  const changes = ledgerChanges(xdr.LedgerCloseMeta.fromXDR(bytes)).filter((change) =>
    accountIdOf(change)?.equals(accountId) === true
  )
  const first = changes[0]
  const last = changes[changes.length - 1]
  return first === undefined || last === undefined
    ? Option.none()
    : Option.some({ before: balanceOf(first, "ledgerEntryCreated"), after: balanceOf(last, "ledgerEntryRemoved") })
}
