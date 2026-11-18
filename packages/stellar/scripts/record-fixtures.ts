// Records real Stellar RPC replies into `test/fixtures/<provider>/<method>[-<case>].json`, replayed by
// `test/StellarRpc.fixtures.test.ts`. Needs the network and QUASAR_API_KEY:
//
//   node --env-file=<path to .env> scripts/record-fixtures.ts [startLedger] [eventsLedger]
//
// Stellar RPC only keeps about 7 days of ledgers, so the pinned range falls out of the retention window: pass a recent
// `startLedger` (a ledger with EUTBL and USTBL events) to move it, then update the values the tests assert.
import { Account, Keypair, Networks, Operation, TransactionBuilder, xdr } from "@stellar/stellar-sdk"
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
// ledgers holding contract events of Soroban transactions, before protocol 23 (`LedgerCloseMeta` v1, protocol 22) and
// after it (v2). The archive endpoint serves every ledger with `TransactionMeta` v4, whatever its protocol.
const V1_SOROBAN_LEDGER = 58000008
const V2_SOROBAN_LEDGER = 59000000
// two ledgers read from both endpoints while the regular one retained them (recorded on 2026-11-17), to compare the
// events decoded from `getLedgers` with every contract event `getEvents` returns. Pass a recent ledger to move them.
const EVENTS_LEDGER = Number(process.argv[3] ?? 65528571)

// transactions of ledgers 65509458 to 65509460, which Stellar RPC only serves for about 7 days: a payment, a failed
// transaction of four operations, a fee bump whose inner transaction failed, and a hash no transaction has. To record
// them again, pick recent ones with `getTransactions` and update the values the tests assert.
const transactions = {
  "success": "8ed811d0439b12fd5f4a2ebd043138079c46a82c9d51544fecb5379bbaf48505",
  "failed": "b1301e5ba2c2b35c9485cd8369f4c258d65666cf270cc3f2f9c03b72dded2059",
  "failed-fee-bump": "f575e03ba3b857e660410be887643c78932a5cbb3be80050ef0bd0949d0fdbaf",
  "not-found": "ab".repeat(32)
}

const accountKey = (address: string) =>
  xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(address).xdrAccountId() }))
    .toXdr("base64")
// an unsigned call of an EUTBL function from Binance's account: a simulation checks neither signature nor sequence
const simulation = (name: string) => ({
  transaction: new TransactionBuilder(new Account(BINANCE, "0"), { fee: "100", networkPassphrase: Networks.PUBLIC })
    .addOperation(Operation.invokeContractFunction({ contract: EUTBL, function: name, args: [] }))
    .setTimeout(0)
    .build()
    .toEnvelope()
    .toXdr("base64")
})
const ledgers = (startLedger: number, limit = 1) => ({ startLedger, pagination: { limit } })
const ledgersAfter = (cursor: string, limit = 1) => ({ pagination: { limit, cursor } })

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
  { name: "getFeeStats", method: "getFeeStats" },
  { name: "simulateTransaction-decimals", method: "simulateTransaction", params: simulation("decimals") },
  { name: "simulateTransaction-error", method: "simulateTransaction", params: simulation("missing") },
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
  { name: "getLedgers-lagging", method: "getLedgers", params: ledgers(FUTURE_LEDGER) },
  { name: "getLedgers-cursor-pruned", method: "getLedgers", params: ledgersAfter(String(V1_LEDGER)) },
  {
    name: "getEvents-all",
    method: "getEvents",
    params: {
      startLedger: EVENTS_LEDGER,
      endLedger: EVENTS_LEDGER + 2,
      filters: [{ type: "contract" }],
      pagination: { limit: 10000 }
    }
  },
  ...Object.entries(transactions).map(([name, hash]) => ({
    name: `getTransaction-${name}`,
    method: "getTransaction",
    params: { hash }
  }))
]

const archiveCases: ReadonlyArray<Case> = [
  { name: "getNetwork", method: "getNetwork" },
  { name: "getLedgers-v0", method: "getLedgers", params: ledgers(V0_LEDGER) },
  { name: "getLedgers-v1", method: "getLedgers", params: ledgers(V1_LEDGER) },
  { name: "getLedgers-v1-soroban", method: "getLedgers", params: ledgers(V1_SOROBAN_LEDGER) },
  { name: "getLedgers-v2-soroban", method: "getLedgers", params: ledgers(V2_SOROBAN_LEDGER) },
  // two small pages of two ledgers, the second after the cursor of the first
  { name: "getLedgers-v0-page", method: "getLedgers", params: ledgers(V0_LEDGER + 1, 2) },
  {
    name: "getLedgers-v0-page-next",
    method: "getLedgers",
    params: (replies) => ledgersAfter(JSON.parse(replies.get("getLedgers-v0-page") ?? "").result.cursor, 2)
  },
  { name: "getLedgers-cursor-lagging", method: "getLedgers", params: ledgersAfter(String(FUTURE_LEDGER)) },
  { name: "getLedgers-recent", method: "getLedgers", params: ledgers(EVENTS_LEDGER, 2) }
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
