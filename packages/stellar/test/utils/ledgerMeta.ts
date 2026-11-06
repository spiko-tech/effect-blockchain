// Builds small `LedgerCloseMeta` v0 XDRs around hand-written account changes, on the header of a recorded ledger.
import * as Replay from "@effect-blockchain/core/test/utils/replay"
import { Keypair, xdr } from "@stellar/stellar-sdk"
import * as Schema from "effect/Schema"
import * as RpcMethods from "../../src/internal/rpcMethods.ts"

const Reply = Schema.fromJsonString(Schema.Struct({ result: RpcMethods.getLedgers.result }))

/** The recorded `getLedgers` reply `<provider>/<name>.json`. */
export const recordedLedger = (provider: string, name: string) =>
  Schema.decodeUnknownSync(Reply)(Replay.load(new URL("../fixtures/", import.meta.url), provider, name).body).result
    .ledgers[0]

const header = xdr.LedgerCloseMeta.fromXDR(recordedLedger("quasar-archive", "getLedgers-v0").metadataXdr, "base64").v0()
  .ledgerHeader()

const accountId = (address: string) => Keypair.fromPublicKey(address).xdrAccountId()

export const account = (address: string, balance: number) =>
  new xdr.LedgerEntry({
    lastModifiedLedgerSeq: 1,
    data: xdr.LedgerEntryData.account(
      new xdr.AccountEntry({
        accountId: accountId(address),
        balance: xdr.Int64.fromString(String(balance)),
        seqNum: xdr.Int64.fromString("1"),
        numSubEntries: 0,
        inflationDest: null,
        flags: 0,
        homeDomain: "",
        thresholds: Buffer.from([1, 0, 0, 0]),
        signers: [],
        ext: new xdr.AccountEntryExt(0)
      })
    ),
    ext: new xdr.LedgerEntryExt(0)
  })

/** A data entry of `address`: it carries the account id but is not the account. */
export const dataEntry = (address: string) =>
  new xdr.LedgerEntry({
    lastModifiedLedgerSeq: 1,
    data: xdr.LedgerEntryData.data(
      new xdr.DataEntry({
        accountId: accountId(address),
        dataName: "name",
        dataValue: Buffer.from("value"),
        ext: new xdr.DataEntryExt(0)
      })
    ),
    ext: new xdr.LedgerEntryExt(0)
  })

export const dataKey = (address: string) =>
  xdr.LedgerKey.data(new xdr.LedgerKeyData({ accountId: accountId(address), dataName: "name" }))

export const accountKey = (address: string) =>
  xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: accountId(address) }))

/** The `STATE` then `UPDATED` changes of a balance going from `from` to `to`. */
export const update = (address: string, from: number, to: number): Array<xdr.LedgerEntryChange> => [
  xdr.LedgerEntryChange.ledgerEntryState(account(address, from)),
  xdr.LedgerEntryChange.ledgerEntryUpdated(account(address, to))
]

export const transaction = (fee: Array<xdr.LedgerEntryChange>, apply: xdr.TransactionMeta) =>
  new xdr.TransactionResultMeta({
    result: new xdr.TransactionResultPair({
      transactionHash: Buffer.alloc(32),
      result: new xdr.TransactionResult({
        feeCharged: xdr.Int64.fromString("100"),
        result: xdr.TransactionResultResult.txSuccess([]),
        ext: new xdr.TransactionResultExt(0)
      })
    }),
    feeProcessing: fee,
    txApplyProcessing: apply
  })

/** A transaction applying `changes` in one operation. */
export const operation = (changes: Array<xdr.LedgerEntryChange>, fee: Array<xdr.LedgerEntryChange> = []) =>
  transaction(fee, new xdr.TransactionMeta(0, [new xdr.OperationMeta({ changes })]))

/** A base64 `LedgerCloseMeta` v0 processing `transactions` in order. */
export const ledgerMeta = (transactions: Array<xdr.TransactionResultMeta>) =>
  new xdr.LedgerCloseMeta(
    0,
    new xdr.LedgerCloseMetaV0({
      ledgerHeader: header,
      txSet: new xdr.TransactionSet({ previousLedgerHash: Buffer.alloc(32), txes: [] }),
      txProcessing: transactions,
      upgradesProcessing: [],
      scpInfo: []
    })
  ).toXDR("base64")
