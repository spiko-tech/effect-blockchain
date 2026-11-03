// Records real Stellar RPC replies into `test/fixtures/<provider>/<method>[-<case>].json`, replayed by
// `test/StellarRpc.fixtures.test.ts`. Needs the network and QUASAR_API_KEY:
//
//   node --env-file=<path to .env> scripts/record-fixtures.ts [startLedger]
//
// Stellar RPC only keeps about 7 days of ledgers, so the pinned range falls out of the retention window: pass a recent
// `startLedger` (a ledger with EUTBL and USTBL events) to move it, then update the values the tests assert.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"

// Spiko tokens, docs.spiko.io/documentation/tokenization/addresses
const EUTBL = "CBGV2QFQBBGEQRUKUMCPO3SZOHDDYO6SCP5CH6TW7EALKVHCXTMWDDOF"
const USTBL = "CARUUX2FZNPH6DGJOEUFSIUQWYHNL5AVDV7PMVSHWL7OBYIBFC76F4TO"

// recorded on 2026-11-03: EUTBL and USTBL events in [65270680, 65271880]
const startLedger = Number(process.argv[2] ?? 65270680)
// `endLedger` is exclusive: the library sends `toBlock + 1`
const endLedger = startLedger + 1201
// long pruned and never reached: the replies do not depend on the recording date
const PRUNED_LEDGER = 60000000
const FUTURE_LEDGER = 999999990

const quasarKey = process.env.QUASAR_API_KEY
if (quasarKey === undefined || quasarKey === "") throw new Error("QUASAR_API_KEY is not set")
const urls: Record<string, string> = {
  quasar: `https://rpc-pro.lightsail.network/${quasarKey}`,
  "quasar-invalid-key": "https://rpc-pro.lightsail.network/invalid-key"
}

type Json = null | boolean | number | string | ReadonlyArray<Json> | { readonly [key: string]: Json }

interface Case {
  // `provider` picks the URL and is written in the fixture, `file` is its path under `test/fixtures`
  readonly provider: string
  readonly file: string
  readonly method: string
  // a function reads the replies recorded before it (by file), to follow a cursor
  readonly params?: Json | ((replies: ReadonlyMap<string, string>) => Json)
}

const contract = (contractIds: ReadonlyArray<string>) => [{ type: "contract", contractIds }]
const range = (start: number, end: number, contractIds: ReadonlyArray<string>, limit: number) => ({
  startLedger: start,
  endLedger: end,
  filters: contract(contractIds),
  pagination: { limit }
})

const cases: ReadonlyArray<Case> = [
  { provider: "quasar", file: "quasar/getNetwork", method: "getNetwork" },
  { provider: "quasar", file: "quasar/getHealth", method: "getHealth" },
  // `getLatestLedger` is not recorded: its reply carries `headerXdr` and `metadataXdr`, about 3 MB
  {
    provider: "quasar",
    file: "quasar/getEvents-eutbl-page-1",
    method: "getEvents",
    params: range(startLedger, endLedger, [EUTBL], 3)
  },
  {
    provider: "quasar",
    file: "quasar/getEvents-eutbl-page-2",
    method: "getEvents",
    params: (replies) => ({
      filters: contract([EUTBL]),
      pagination: { cursor: JSON.parse(replies.get("quasar/getEvents-eutbl-page-1") ?? "").result.cursor, limit: 3 }
    })
  },
  {
    provider: "quasar",
    file: "quasar/getEvents-ustbl",
    method: "getEvents",
    params: range(startLedger, endLedger, [USTBL], 3)
  },
  {
    provider: "quasar",
    file: "quasar/getEvents-pruned",
    method: "getEvents",
    params: range(PRUNED_LEDGER, PRUNED_LEDGER + 11, [EUTBL], 3)
  },
  {
    provider: "quasar",
    file: "quasar/getEvents-lagging",
    method: "getEvents",
    params: range(FUTURE_LEDGER, FUTURE_LEDGER + 11, [EUTBL], 3)
  },
  {
    provider: "quasar",
    file: "quasar/invalid-params",
    method: "getEvents",
    params: range(startLedger, endLedger, [EUTBL], 20000)
  },
  { provider: "quasar-invalid-key", file: "quasar/invalid-key", method: "getNetwork" }
]

const fixtures = new URL("../test/fixtures/", import.meta.url)
const recordedAt = new Date().toISOString().slice(0, 10)
const replies = new Map<string, string>()

for (const { file, method, params: input, provider } of cases) {
  const params = typeof input === "function" ? input(replies) : input
  const response = await fetch(urls[provider], {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) })
  })
  const body = await response.text()
  replies.set(file, body)
  const fixture = {
    provider,
    network: "Stellar",
    recordedAt,
    request: { method, ...(params === undefined ? {} : { params }) },
    status: response.status,
    body
  }
  const path = new URL(`${file}.json`, fixtures)
  mkdirSync(new URL(".", path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`)
  process.stdout.write(`${file}: ${response.status}, ${body.length} bytes\n`)
}

// no key and no keyed URL may reach a committed file
const secrets = [process.env.INFURA_TOKEN, process.env.ALCHEMY_API_KEY, quasarKey, ...Object.values(urls)]
  .filter((secret): secret is string => secret !== undefined && secret !== "")
for (const file of readdirSync(fixtures, { recursive: true, encoding: "utf8" })) {
  if (!file.endsWith(".json")) continue
  const text = readFileSync(new URL(file, fixtures), "utf8")
  if (secrets.some((secret) => text.includes(secret))) throw new Error(`${file} contains a key or a provider URL`)
}
