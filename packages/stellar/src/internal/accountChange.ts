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

/**
 * The account of a base64 XDR `LedgerEntryData`. Throws on another entry type or a malformed entry.
 *
 * @internal
 */
export const accountEntry = (dataXdr: string): xdr.AccountEntry => {
  const data = xdr.LedgerEntryData.fromXdr(dataXdr, "base64")
  if (data.type !== "account") throw new Error(`expected an account entry, got ${data.type}`)
  return data.account
}

const applyChanges = (meta: xdr.TransactionMeta): ReadonlyArray<xdr.LedgerEntryChange> => {
  switch (meta.type) {
    case "operations":
      return meta.operations.flatMap((operation) => operation.changes)
    case "v1":
      return [...meta.v1.txChanges, ...meta.v1.operations.flatMap((operation) => operation.changes)]
    default:
      return [
        ...meta.value.txChangesBefore,
        ...meta.value.operations.flatMap((operation: xdr.OperationMeta | xdr.OperationMetaV2) => operation.changes),
        ...meta.value.txChangesAfter
      ]
  }
}

// stellar-core charges the fees of every transaction before applying any, then (protocol 23, `LedgerCloseMetaV2`)
// applies the Soroban fee refunds after all of them:
// https://github.com/stellar/stellar-xdr/blob/curr/Stellar-ledger.x (`TransactionResultMetaV1`)
const ledgerChanges = (meta: xdr.LedgerCloseMeta): ReadonlyArray<xdr.LedgerEntryChange> => {
  const txs: ReadonlyArray<xdr.TransactionResultMeta | xdr.TransactionResultMetaV1> = meta.value.txProcessing
  return [
    ...txs.flatMap((tx) => tx.feeProcessing),
    ...txs.flatMap((tx) => applyChanges(tx.txApplyProcessing)),
    ...txs.flatMap((tx) => tx instanceof xdr.TransactionResultMetaV1 ? tx.postTxApplyFeeProcessing : [])
  ]
}

const accountIdOf = (change: xdr.LedgerEntryChange): xdr.Uint256Bytes | undefined => {
  if (change.type === "ledgerEntryRemoved") {
    return change.removed.type === "account" ? change.removed.account.accountId.ed25519 : undefined
  }
  return change.value.data.type === "account" ? change.value.data.account.accountId.ed25519 : undefined
}

// a removed account (merged) holds nothing, and a created one held nothing before
const balanceOf = (change: xdr.LedgerEntryChange, missing: xdr.LedgerEntryChange["type"]): bigint =>
  change.type === missing || change.type === "ledgerEntryRemoved" || change.value.data.type !== "account"
    ? BigInt(0)
    : change.value.data.account.balance

// the changes of `address` in a ledger, in the order stellar-core applies them
const accountChanges = (metadataXdr: string, address: StellarAccountAddress): ReadonlyArray<xdr.LedgerEntryChange> => {
  const bytes = Buffer.from(metadataXdr, "base64")
  const accountId = StrKey.decodeEd25519PublicKey(address)
  // every change of the account carries its id verbatim: most ledgers are skipped without decoding (1 to 3 MB)
  if (!bytes.includes(accountId)) return []
  const key = new xdr.Uint256Bytes(accountId)
  return ledgerChanges(xdr.LedgerCloseMeta.fromXdr(bytes)).filter((change) => accountIdOf(change)?.equals(key) === true)
}

/**
 * The native balance of `address` around its changes in a ledger, from the base64 XDR `LedgerCloseMeta` of
 * `getLedgers` (versions 0 to 2, fee processing, operations and Soroban fee refunds, fee-bump fee sources included).
 * `None` when the ledger does not change the account. Throws on a malformed meta.
 *
 * @internal
 */
export const accountChange = (metadataXdr: string, address: StellarAccountAddress): Option.Option<AccountChange> => {
  const changes = accountChanges(metadataXdr, address)
  const first = changes[0]
  const last = changes[changes.length - 1]
  return first === undefined || last === undefined
    ? Option.none()
    : Option.some({ before: balanceOf(first, "ledgerEntryCreated"), after: balanceOf(last, "ledgerEntryRemoved") })
}

/**
 * The account of `address` before its first change in a ledger: `created` when the ledger creates it, else its
 * balance in stroops and the ledger that last changed it. `None` when the ledger does not change the account. Throws
 * on a malformed meta, or a first change other than `STATE` or `CREATED`.
 *
 * @internal
 */
export const accountBefore = (
  metadataXdr: string,
  address: StellarAccountAddress
): Option.Option<
  { readonly created: true } | {
    readonly created: false
    readonly balance: bigint
    readonly lastModifiedLedger: bigint
  }
> => {
  const first = accountChanges(metadataXdr, address)[0]
  if (first === undefined) return Option.none()
  if (first.type === "ledgerEntryCreated") return Option.some({ created: true })
  // stellar-core records an entry's `STATE` before its first update or removal in a ledger
  if (first.type !== "ledgerEntryState") throw new Error(`expected the account's state first, got ${first.type}`)
  return Option.some({
    created: false,
    balance: balanceOf(first, "ledgerEntryCreated"),
    lastModifiedLedger: BigInt(first.value.lastModifiedLedgerSeq)
  })
}
