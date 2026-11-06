// Records real Stellar RPC replies into `test/fixtures/<provider>/<method>[-<case>].json`, replayed by
// `test/StellarRpc.fixtures.test.ts`. Needs the network and QUASAR_API_KEY:
//
//   node --env-file=<path to .env> scripts/record-fixtures.ts [startLedger]
//
// Stellar RPC only keeps about 7 days of ledgers, so the pinned range falls out of the retention window: pass a recent
// `startLedger` (a ledger with EUTBL and USTBL events) to move it, then update the values the tests assert.
import { Keypair, xdr } from "@stellar/stellar-sdk"
import { type Case, record, secret } from "../../core/scripts/recordFixtures.ts"

// tokenized fund tokens
const EUTBL = "CBGV2QFQBBGEQRUKUMCPO3SZOHDDYO6SCP5CH6TW7EALKVHCXTMWDDOF"
const USTBL = "CARUUX2FZNPH6DGJOEUFSIUQWYHNL5AVDV7PMVSHWL7OBYIBFC76F4TO"

// recorded on 2026-11-03: EUTBL and USTBL events in [65270680, 65271880]
const startLedger = Number(process.argv[2] ?? 65270680)
// `endLedger` is exclusive: the library sends `toBlock + 1`
const endLedger = startLedger + 1201
// long pruned and never reached: the replies do not depend on the recording date
const PRUNED_LEDGER = 60000000
const FUTURE_LEDGER = 999999990

// Binance's hot wallet, changed almost every ledger, and the all-ones key, an account that does not exist (the
// all-zero one does)
const BINANCE = "GABFQIK63R2NETJM7T673EAMZN4RJLLGP3OFUEJU5SZVTGWUKULZJNL6"
const MISSING = "GD7777777777777777777777777777777777777777777777777773DB"
// history served by the archive endpoint only: a `LedgerCloseMeta` v0 ledger (2020) with a failed transaction and a
// v1 ledger (2025) with fee-bump transactions
const V0_LEDGER = 30000002
const V1_LEDGER = 55000004

const accountKey = (address: string) =>
  xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(address).xdrAccountId() }))
    .toXDR("base64")
const ledgers = (startLedger: number) => ({ startLedger, pagination: { limit: 1 } })

const contract = (contractIds: ReadonlyArray<string>) => [{ type: "contract", contractIds }]
const range = (start: number, end: number, contractIds: ReadonlyArray<string>, limit: number) => ({
  startLedger: start,
  endLedger: end,
  filters: contract(contractIds),
  pagination: { limit }
})

const cases: ReadonlyArray<Case> = [
  { name: "getNetwork", method: "getNetwork" },
  { name: "getHealth", method: "getHealth" },
  // `getLatestLedger` is not recorded: its reply carries `headerXdr` and `metadataXdr`, about 3 MB
  {
    name: "getEvents-eutbl-page-1",
    method: "getEvents",
    params: range(startLedger, endLedger, [EUTBL], 3)
  },
  {
    name: "getEvents-eutbl-page-2",
    method: "getEvents",
    params: (replies) => ({
      filters: contract([EUTBL]),
      pagination: { cursor: JSON.parse(replies.get("getEvents-eutbl-page-1") ?? "").result.cursor, limit: 3 }
    })
  },
  {
    name: "getEvents-ustbl",
    method: "getEvents",
    params: range(startLedger, endLedger, [USTBL], 3)
  },
  {
    name: "getEvents-pruned",
    method: "getEvents",
    params: range(PRUNED_LEDGER, PRUNED_LEDGER + 11, [EUTBL], 3)
  },
  {
    name: "getEvents-lagging",
    method: "getEvents",
    params: range(FUTURE_LEDGER, FUTURE_LEDGER + 11, [EUTBL], 3)
  },
  {
    name: "invalid-params",
    method: "getEvents",
    params: range(startLedger, endLedger, [EUTBL], 20000)
  },
  { name: "invalid-key", method: "getNetwork", invalidKey: true },
  { name: "getLedgerEntries-binance", method: "getLedgerEntries", params: { keys: [accountKey(BINANCE)] } },
  { name: "getLedgerEntries-missing", method: "getLedgerEntries", params: { keys: [accountKey(MISSING)] } },
  // the ledger of Binance's last change, about 2 MB
  {
    name: "getLedgers-binance",
    method: "getLedgers",
    params: (replies) =>
      ledgers(JSON.parse(replies.get("getLedgerEntries-binance") ?? "").result.entries[0].lastModifiedLedgerSeq)
  },
  { name: "getLedgers-pruned", method: "getLedgers", params: ledgers(V1_LEDGER) },
  { name: "getLedgers-lagging", method: "getLedgers", params: ledgers(FUTURE_LEDGER) }
]

const archiveCases: ReadonlyArray<Case> = [
  { name: "getNetwork", method: "getNetwork" },
  { name: "getLedgers-v0", method: "getLedgers", params: ledgers(V0_LEDGER) },
  { name: "getLedgers-v1", method: "getLedgers", params: ledgers(V1_LEDGER) }
]

await record({
  network: "Stellar",
  fixtures: new URL("../test/fixtures/", import.meta.url),
  providers: [
    { name: "quasar", url: (key) => `https://rpc-pro.lightsail.network/${key}`, key: secret("QUASAR_API_KEY") }
  ],
  cases
})

await record({
  network: "Stellar",
  fixtures: new URL("../test/fixtures/", import.meta.url),
  providers: [{
    name: "quasar-archive",
    url: (key) => `https://archive-rpc-pro.lightsail.network/${key}`,
    key: secret("QUASAR_API_KEY")
  }],
  cases: archiveCases
})
