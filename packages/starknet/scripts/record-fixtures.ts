// Records real Starknet mainnet provider replies into `test/fixtures/<provider>/<case>.json`, replayed by
// `test/StarknetRpc.fixtures.test.ts`. Needs the network and the keys, never written to the fixtures:
//
//   node --env-file=$HOME/spiko/loop-crypto/.env scripts/record-fixtures.ts
//
// Inputs are pinned (past block range, transaction hash) so a re-run records the same replies, except the head.
// Bodies are the same as the ones `src/internal/rpcMethods.ts` encodes.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

type Json = null | boolean | number | string | ReadonlyArray<Json> | { readonly [key: string]: Json }

interface Case {
  readonly name: string
  readonly method: string
  // receives the bodies already recorded for this provider, to continue a page
  readonly params: (recorded: ReadonlyMap<string, string>) => Json
  readonly invalidKey?: boolean
}

const env = (name: string): string => {
  const value = process.env[name]
  if (value === undefined || value === "") throw new Error(`missing ${name}`)
  return value
}

const keys = { alchemy: env("ALCHEMY_API_KEY"), infura: env("INFURA_TOKEN"), quasar: env("QUASAR_API_KEY") }

const hosts = { alchemy: "starknet-mainnet.g.alchemy.com", infura: "starknet-mainnet.infura.io" }

const providers: Record<keyof typeof hosts, (key: string) => string> = {
  alchemy: (key) => `https://${hosts.alchemy}/starknet/version/rpc/v0_9/${key}`,
  infura: (key) => `https://${hosts.infura}/v3/${key}`
}

// Spiko EUTBL on Starknet, blocks 1380300..1380400 hold 12 Transfer events in 3 transactions
const EUTBL = "0x04f5e0de717daa6aa8de63b1bf2e8d7823ec5b21a88461b1519d9dbc956fb7f2"
const RECEIPT_TX = "0x02aa671ff923b87808ec822766994ed10fd5720d7441798a96fbd770c0b7e9ab"

const events = (filter: { readonly [key: string]: Json }): Json => ({
  filter: {
    address: EUTBL,
    from_block: { block_number: 1380300 },
    to_block: { block_number: 1380400 },
    chunk_size: 5,
    ...filter
  }
})

const continuationToken = (body: string | undefined): string => {
  const token = body === undefined ? undefined : JSON.parse(body).result?.continuation_token
  if (typeof token !== "string") throw new Error("getEvents-page-1 returned no continuation_token")
  return token
}

const cases: ReadonlyArray<Case> = [
  { name: "chainId", method: "starknet_chainId", params: () => ({}) },
  { name: "blockNumber", method: "starknet_blockNumber", params: () => ({}) },
  { name: "getEvents-page-1", method: "starknet_getEvents", params: () => events({}) },
  {
    name: "getEvents-page-2",
    method: "starknet_getEvents",
    params: (recorded) => events({ continuation_token: continuationToken(recorded.get("getEvents-page-1")) })
  },
  {
    name: "getTransactionReceipt",
    method: "starknet_getTransactionReceipt",
    params: () => ({ transaction_hash: RECEIPT_TX })
  },
  {
    name: "getEvents-beyond-head",
    method: "starknet_getEvents",
    params: () => events({ to_block: { block_number: 99999999 } })
  },
  { name: "getEvents-chunk-too-big", method: "starknet_getEvents", params: () => events({ chunk_size: 10000 }) },
  {
    name: "getEvents-invalid-token",
    method: "starknet_getEvents",
    params: () => events({ continuation_token: "invalid" })
  },
  { name: "invalid-key", method: "starknet_chainId", params: () => ({}), invalidKey: true }
]

const fixtures = join(import.meta.dirname, "..", "test", "fixtures")
const recordedAt = new Date().toISOString().slice(0, 10)

for (const [provider, url] of Object.entries(providers)) {
  const key = keys[provider as keyof typeof providers]
  const recorded = new Map<string, string>()
  mkdirSync(join(fixtures, provider), { recursive: true })
  for (const { invalidKey, method, name, params: makeParams } of cases) {
    const params = makeParams(recorded)
    const response = await fetch(url(invalidKey === true ? "invalid-api-key" : key), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
    })
    const body = await response.text()
    recorded.set(name, body)
    const fixture = {
      provider,
      network: "Starknet",
      recordedAt,
      request: { method, params },
      status: response.status,
      body
    }
    writeFileSync(join(fixtures, provider, `${name}.json`), JSON.stringify(fixture, null, 2) + "\n")
    process.stdout.write(`${provider} ${name}: ${response.status} ${body.length} bytes\n`)
  }
}

// sanitize check: no key and no provider URL in any fixture
const secrets = [...Object.values(keys), ...Object.values(hosts)]
for (const entry of readdirSync(fixtures, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue
  const file = join(entry.parentPath, entry.name)
  if (secrets.some((secret) => readFileSync(file, "utf8").includes(secret))) {
    throw new Error(`${file} contains a key or a provider URL`)
  }
}
process.stdout.write("fixtures sanitized\n")
