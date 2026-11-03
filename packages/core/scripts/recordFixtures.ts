// Records real provider replies into `<fixtures>/<provider>/<case>.json`, replayed by `test/utils/replay.ts`. Imported
// by each chain's `scripts/record-fixtures.ts`, which holds its pinned inputs, cases and providers. Never edit a reply.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"

export type Json = null | boolean | number | string | ReadonlyArray<Json> | { readonly [key: string]: Json }

export interface Case {
  readonly name: string
  readonly method: string
  // absent when the method takes none; a function receives the bodies already recorded for this provider, by case
  // name, to follow a cursor
  readonly params?: Json | ((recorded: ReadonlyMap<string, string>) => Json)
  // sends a made-up key instead of the real one
  readonly invalidKey?: boolean
}

export interface Provider {
  readonly name: string
  readonly url: (key: string) => string
  readonly key: string
}

/** Reads a key from the environment, failing before any request when it is missing. */
export const secret = (name: string): string => {
  const value = process.env[name]
  if (value === undefined || value === "") throw new Error(`${name} is not set`)
  return value
}

const send = async (url: string, method: string, params: Json | undefined) => {
  const post = () =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) })
    })
  let response = await post()
  // the free tiers rate-limit bursts with a 429: wait and send again rather than record it
  for (let attempt = 1; response.status === 429; attempt++) {
    if (attempt > 5) throw new Error(`${url.split("/")[2]} ${method}: still rate-limited`)
    await new Promise((resolve) => setTimeout(resolve, 2000 * attempt))
    response = await post()
  }
  return response
}

export const record = async (options: {
  readonly network: string
  readonly fixtures: URL
  readonly providers: ReadonlyArray<Provider>
  readonly cases: ReadonlyArray<Case>
}): Promise<void> => {
  const { cases, fixtures, network, providers } = options
  const recordedAt = new Date().toISOString().slice(0, 10)
  for (const provider of providers) {
    const recorded = new Map<string, string>()
    mkdirSync(new URL(`${provider.name}/`, fixtures), { recursive: true })
    for (const { invalidKey, method, name, params: input } of cases) {
      const params = typeof input === "function" ? input(recorded) : input
      const response = await send(provider.url(invalidKey === true ? "invalid-key" : provider.key), method, params)
      const body = await response.text()
      recorded.set(name, body)
      const fixture = {
        provider: provider.name,
        network,
        recordedAt,
        request: { method, ...(params === undefined ? {} : { params }) },
        status: response.status,
        body
      }
      writeFileSync(new URL(`${provider.name}/${name}.json`, fixtures), `${JSON.stringify(fixture, null, 2)}\n`)
      process.stdout.write(`${provider.name} ${name}: ${response.status}, ${body.length} bytes\n`)
    }
  }

  // no key and no provider host may reach a committed fixture
  const secrets = [
    ...["INFURA_TOKEN", "ALCHEMY_API_KEY", "QUASAR_API_KEY"].map((name) => process.env[name] ?? ""),
    ...providers.flatMap((provider) => [provider.key, new URL(provider.url("")).host])
  ].filter((value) => value !== "")
  for (const file of readdirSync(fixtures, { recursive: true, encoding: "utf8" })) {
    if (!file.endsWith(".json")) continue
    const text = readFileSync(new URL(file, fixtures), "utf8")
    if (secrets.some((value) => text.includes(value))) throw new Error(`${file} contains a key or a provider host`)
  }
  process.stdout.write("fixtures sanitized\n")
}
