// Replays the real provider replies recorded by each chain's `scripts/record-fixtures.ts` (see
// `packages/core/scripts/recordFixtures.ts`), to run through that chain's real rpc layer
import * as Arr from "effect/Array"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { readFileSync } from "node:fs"
import { isDeepStrictEqual } from "node:util"

// `params` is absent when the method takes none (Stellar `getNetwork`)
const Request = Schema.Struct({ method: Schema.String, params: Schema.optionalKey(Schema.Json) })

export const Fixture = Schema.Struct({
  provider: Schema.String,
  network: Schema.String,
  recordedAt: Schema.String,
  request: Request,
  status: Schema.Number,
  body: Schema.String
})
export type Fixture = typeof Fixture.Type

/** Reads `<dir>/<provider>/<name>.json`. */
export const load = (dir: URL, provider: string, name: string): Fixture =>
  Schema.decodeUnknownSync(Schema.fromJsonString(Fixture))(
    readFileSync(new URL(`${provider}/${name}.json`, dir), "utf8")
  )

export interface Endpoint {
  readonly name: string
  // the fixtures directory, when it is not the endpoint name (a second endpoint of the same provider)
  readonly provider?: string
  readonly cases: ReadonlyArray<string>
}

/**
 * One replay `fetch` for every endpoint, routed by host (`https://<name>.fixture`): each endpoint answers from its own
 * fixtures, matched on method and params. `served` lists `<endpoint> <case>` in order, `check` fails an effect that
 * sent a request no fixture matches, whatever the effect returned.
 */
export const replay = (dir: URL, endpoints: Arr.NonEmptyReadonlyArray<Endpoint>) => {
  const fixtures = new Map(
    endpoints.map(({ cases, name, provider = name }) => [
      name,
      cases.map((name) => ({ name, ...load(dir, provider, name) }))
    ])
  )
  const served: Array<string> = []
  const unmatched: Array<string> = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const name = new URL(String(input)).hostname.replace(/\.fixture$/u, "")
    const { method, params } = Schema.decodeUnknownSync(Schema.fromJsonString(Request))(
      await new Response(init?.body).text()
    )
    const fixture = fixtures.get(name)?.find(({ request }) =>
      request.method === method && isDeepStrictEqual(request.params, params)
    )
    if (fixture === undefined) {
      unmatched.push(`${name} ${method} ${JSON.stringify(params)}`)
      return new Response("no fixture", { status: 599 })
    }
    served.push(`${name} ${fixture.name}`)
    return new Response(fixture.body, { status: fixture.status })
  }
  const check = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.exit(effect).pipe(
      Effect.flatMap((exit) =>
        unmatched.length > 0 ? Effect.die(new Error(`no fixture for: ${unmatched.join(", ")}`)) : exit
      )
    )
  return {
    fetch,
    endpoints: Arr.map(endpoints, ({ name }) => ({ name, url: Redacted.make(`https://${name}.fixture`) })),
    served,
    check
  }
}
