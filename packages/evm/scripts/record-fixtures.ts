// Records real Ethereum mainnet replies from Alchemy and Infura into `test/fixtures/<provider>/<case>.json`, replayed by
// `test/EvmRpc.fixtures.test.ts`. Needs the network and the keys in the environment:
//   node --env-file=<path to .env> scripts/record-fixtures.ts
// Inputs are pinned, so a re-run records the same replies (except `blockNumber`, the moving head). Never edit a reply.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"

type Json = null | boolean | number | string | ReadonlyArray<Json> | { readonly [key: string]: Json }

// Spiko EUTBL and USTBL (docs.spiko.io/documentation/tokenization/addresses), lowercased as `EvmAddress` encodes them
const SPIKO_TOKENS = ["0xa0769f7a8fc65e47de93797b4e21c073c117fc80", "0xe4880249745eac5f1ed9d8f7df844792d560e750"]
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
// blocks 26083549..26083558: 4 USTBL and 1 EUTBL Transfer logs, within Alchemy's free-tier 10-block range
const FROM = 26083549
const TO = 26083558

const hex = (n: number) => `0x${n.toString(16)}`
const logsFilter = (fromBlock: string, toBlock: string, topics: Json = [TRANSFER]) => [
  { address: SPIKO_TOKENS, fromBlock, toBlock, topics }
]

const cases: ReadonlyArray<{ readonly name: string; readonly method: string; readonly params: Json; badKey?: true }> = [
  { name: "chainId", method: "eth_chainId", params: [] },
  { name: "blockNumber", method: "eth_blockNumber", params: [] },
  { name: "getLogs", method: "eth_getLogs", params: logsFilter(hex(FROM), hex(TO)) },
  // 10010 blocks: above Alchemy's free tier (10) and Infura's (10000) limits
  { name: "getLogs-range-too-large", method: "eth_getLogs", params: logsFilter(hex(TO - 10009), hex(TO)) },
  { name: "getLogs-beyond-head", method: "eth_getLogs", params: logsFilter("0xfffffff6", "0xffffffff") },
  // a 1-byte topic, which the library encodes as given
  { name: "invalid-params", method: "eth_getLogs", params: logsFilter(hex(FROM), hex(TO), [["0xab"]]) },
  { name: "invalid-key", method: "eth_chainId", params: [], badKey: true }
]

const secret = (name: string) => {
  const value = process.env[name]
  if (value === undefined || value === "") throw new Error(`${name} is not set`)
  return value
}

const providers = [
  { name: "alchemy", base: "https://eth-mainnet.g.alchemy.com/v2/", key: secret("ALCHEMY_API_KEY") },
  { name: "infura", base: "https://mainnet.infura.io/v3/", key: secret("INFURA_TOKEN") }
]

const fixtures = new URL("../test/fixtures/", import.meta.url)
const recordedAt = new Date().toISOString().slice(0, 10)

for (const provider of providers) {
  mkdirSync(new URL(`${provider.name}/`, fixtures), { recursive: true })
  for (const { badKey, method, name, params } of cases) {
    const send = () =>
      fetch(`${provider.base}${badKey ? "invalid-key" : provider.key}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
      })
    let response = await send()
    // the free tiers rate-limit bursts with a 429: wait and send again rather than record it
    for (let attempt = 1; response.status === 429; attempt++) {
      if (attempt > 5) throw new Error(`${provider.name} ${name}: still rate-limited`)
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt))
      response = await send()
    }
    const fixture = {
      provider: provider.name,
      network: "Ethereum",
      recordedAt,
      request: { method, params },
      status: response.status,
      body: await response.text()
    }
    writeFileSync(new URL(`${provider.name}/${name}.json`, fixtures), `${JSON.stringify(fixture, null, 2)}\n`)
    console.log(`${provider.name} ${name}: ${response.status}`)
  }
}

// no key and no provider URL may reach a fixture
const forbidden = [
  ...providers.flatMap((provider) => [provider.key, provider.base.replace("https://", "")]),
  ...[process.env.QUASAR_API_KEY ?? ""].filter((key) => key !== "")
]
for (const provider of readdirSync(fixtures)) {
  for (const file of readdirSync(new URL(`${provider}/`, fixtures))) {
    const text = readFileSync(new URL(`${provider}/${file}`, fixtures), "utf8")
    if (forbidden.some((value) => text.includes(value))) throw new Error(`${provider}/${file} contains a secret or URL`)
  }
}
