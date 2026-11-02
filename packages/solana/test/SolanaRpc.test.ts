import { SolanaAddress } from "@effect-blockchain/solana/SolanaAddress"
import * as SolanaRpc from "@effect-blockchain/solana/SolanaRpc"
import { SolanaTransactionHash } from "@effect-blockchain/solana/SolanaTransactionHash"
import { assert, describe, expect, it } from "@effect/vitest"
import * as Arr from "effect/Array"
import * as Clock from "effect/Clock"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import type * as Schema from "effect/Schema"
import * as Tracer from "effect/Tracer"

type Reply = { readonly result: Schema.Json } | { readonly error: { code: number; message: string } } | Response
type Node = Record<
  string,
  (params: ReadonlyArray<Schema.Json>, signal: AbortSignal | null | undefined) => Reply | Promise<Reply>
>

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
const ADDRESS = SolanaAddress.make("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
const SIGNATURE = SolanaTransactionHash.make(
  "5UfDuX7WXYZdgnWkLhKnga5PsaFdMNQdi5SBPYB4RY5UBbQDN3kQz3VEABDaGbNkYPhGMaFKaLwUMcnMnEHG77v"
)
const OLDER = SolanaTransactionHash.make(
  "4UfDuX7WXYZdgnWkLhKnga5PsaFdMNQdi5SBPYB4RY5UBbQDN3kQz3VEABDaGbNkYPhGMaFKaLwUMcnMnEHG77v"
)

const defaults: Node = { getGenesisHash: () => ({ result: MAINNET_GENESIS }) }

// one fake fetch serving every endpoint, routed by host: `https://<name>.rpc.test/secret-key`
const setup = (
  nodes: Record<string, Node>,
  options: { readonly retries?: number; readonly timeout?: Duration.Input } = {}
) => {
  const calls: Array<string> = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const name = new URL(String(input)).hostname.split(".")[0]
    const body: { id: number; method: string; params: ReadonlyArray<Schema.Json> } = JSON.parse(
      await new Response(init?.body).text()
    )
    calls.push(`${name}:${body.method}`)
    const handler = nodes[name]?.[body.method] ?? defaults[body.method]
    const reply = handler === undefined
      ? { error: { code: -32601, message: "method not found" } }
      : await handler(body.params, init?.signal)
    return reply instanceof Response ? reply : Response.json({ jsonrpc: "2.0", id: body.id, ...reply })
  }
  const names = Object.keys(nodes)
  if (!Arr.isReadonlyArrayNonEmpty(names)) throw new Error("setup needs at least one endpoint")
  const layer = SolanaRpc.layer({
    network: "Solana",
    endpoints: Arr.map(names, (name) => ({ name, url: Redacted.make(`https://${name}.rpc.test/secret-key`) })),
    retries: options.retries ?? 0,
    retryDelay: "1 millis",
    timeout: options.timeout
  }).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)))
  const run = <A, E>(f: (rpc: SolanaRpc.SolanaRpc["Service"]) => Effect.Effect<A, E>) =>
    Effect.gen(function*() {
      return yield* f(yield* SolanaRpc.SolanaRpc)
    }).pipe(Effect.provide(layer))
  return { calls, run }
}

// an error, its causes and the errors they aggregate, recursively
const causeChain = (error: Error): Array<Error> => [
  error,
  ...(error.cause instanceof Error ? causeChain(error.cause) : []),
  ...(error instanceof AggregateError
    ? error.errors.flatMap((item) => item instanceof Error ? causeChain(item) : [])
    : [])
]

const slot = (value: number) => () => ({ result: value })
const confirmed = { commitment: "confirmed" } as const
const raw = (body: string) => () =>
  new Response(`{"jsonrpc":"2.0","id":1,${body}}`, { headers: { "content-type": "application/json" } })

describe("SolanaRpc", () => {
  it.effect("decodes getGenesisHash, getSlot and getSignaturesForAddress", () => {
    const { run } = setup({
      a: {
        getSlot: slot(300),
        getSignaturesForAddress: () => ({
          result: [
            { signature: SIGNATURE, slot: 12, blockTime: 1700000000, err: null, memo: null, confirmationStatus: "x" },
            { signature: OLDER, slot: 11, blockTime: null, err: { InstructionError: [0, { Custom: 1 }] }, memo: "m" }
          ]
        })
      }
    })
    return run((rpc) =>
      Effect.gen(function*() {
        expect(yield* rpc.getGenesisHash).toBe(MAINNET_GENESIS)
        expect(yield* rpc.getSlot(confirmed)).toBe(BigInt(300))
        expect(yield* rpc.getSignaturesForAddress({ address: ADDRESS, ...confirmed })).toStrictEqual([
          { signature: SIGNATURE, slot: BigInt(12), blockTime: BigInt(1700000000), err: null, memo: null },
          {
            signature: OLDER,
            slot: BigInt(11),
            blockTime: null,
            err: { InstructionError: ["0", { Custom: "1" }] },
            memo: "m"
          }
        ])
      })
    )
  })

  it.effect("encodes getSignaturesForAddress params and leaves undefined keys out", () => {
    let params: ReadonlyArray<Schema.Json> = []
    const { run } = setup({
      a: {
        getSignaturesForAddress: (p) => {
          params = p
          return { result: [] }
        }
      }
    })
    return run((rpc) =>
      rpc.getSignaturesForAddress({
        address: ADDRESS,
        before: SIGNATURE,
        until: OLDER,
        limit: 1000,
        commitment: "finalized",
        minContextSlot: BigInt(42)
      }).pipe(
        Effect.map(() =>
          expect(params).toStrictEqual([ADDRESS, {
            before: SIGNATURE,
            until: OLDER,
            limit: 1000,
            commitment: "finalized",
            minContextSlot: 42
          }])
        ),
        Effect.andThen(rpc.getSignaturesForAddress({ address: ADDRESS, before: undefined, ...confirmed })),
        Effect.map(() => expect(params).toStrictEqual([ADDRESS, { commitment: "confirmed" }]))
      )
    )
  })

  it.effect("returns getTransaction with u64 values exact", () => {
    let params: ReadonlyArray<Schema.Json> = []
    const { run } = setup({
      a: {
        getTransaction: (p) => {
          params = p
          return raw(
            `"result":{"slot":12,"blockTime":1700000000,"transaction":["AQID","base64"],"version":0,` +
              `"meta":{"err":null,"fee":5000,"preBalances":[18446744073709551615],"logMessages":["ok"]}}`
          )()
        }
      }
    })
    return run((rpc) => rpc.getTransaction({ signature: SIGNATURE, ...confirmed })).pipe(Effect.map((tx) => {
      expect(params).toStrictEqual([SIGNATURE, {
        commitment: "confirmed",
        encoding: "base64",
        maxSupportedTransactionVersion: 0
      }])
      expect(tx).toStrictEqual({
        slot: BigInt(12),
        blockTime: BigInt(1700000000),
        transaction: "AQID",
        meta: { err: null, fee: "5000", preBalances: ["18446744073709551615"], logMessages: ["ok"] }
      })
    }))
  })

  it.effect("keeps a u64 slot above 2^53 exact", () =>
    setup({ a: { getSlot: raw(`"result":9007199254740993`) } }).run((rpc) => rpc.getSlot(confirmed)).pipe(
      Effect.map((value) => expect(value).toBe(BigInt("9007199254740993")))
    ))

  it.effect("falls back when getTransaction returns null", () => {
    const tx = { slot: 1, blockTime: null, transaction: ["AQID", "base64"], meta: null }
    const { calls, run } = setup({
      a: { getTransaction: () => ({ result: null }) },
      b: { getTransaction: () => ({ result: tx }) }
    })
    return run((rpc) =>
      Effect.gen(function*() {
        expect((yield* rpc.getTransaction({ signature: SIGNATURE, ...confirmed })).meta).toBeNull()
        expect(calls).toStrictEqual(["a:getGenesisHash", "a:getTransaction", "b:getGenesisHash", "b:getTransaction"])
        const pruned = setup({ a: { getTransaction: () => ({ result: null }) } })
        const error = yield* pruned.run((rpc) =>
          Effect.flip(rpc.getTransaction({ signature: SIGNATURE, ...confirmed }))
        )
        expect(error).toMatchObject({ reason: "Pruned", method: "getTransaction" })
      })
    )
  })

  it.effect("maps minContextSlot not reached to Lagging and falls back", () => {
    const { calls, run } = setup({
      a: {
        getSignaturesForAddress: () => ({
          error: { code: -32016, message: "Minimum context slot has not been reached" }
        })
      },
      b: { getSignaturesForAddress: () => ({ result: [] }) }
    })
    return run((rpc) => rpc.getSignaturesForAddress({ address: ADDRESS, minContextSlot: BigInt(50), ...confirmed }))
      .pipe(Effect.map((page) => {
        expect(page).toStrictEqual([])
        expect(calls).toStrictEqual([
          "a:getGenesisHash",
          "a:getSignaturesForAddress",
          "b:getGenesisHash",
          "b:getSignaturesForAddress"
        ])
      }))
  })

  it.effect("falls back in order and stops on Rejected", () =>
    Effect.gen(function*() {
      const down = () => new Response("down", { status: 503 })
      const fallback = setup({ a: { getSlot: down }, b: { getSlot: slot(7) } })
      expect(yield* fallback.run((rpc) => rpc.getSlot(confirmed))).toBe(BigInt(7))
      expect(fallback.calls).toStrictEqual(["a:getGenesisHash", "a:getSlot", "b:getGenesisHash", "b:getSlot"])

      const rejected = () => ({ error: { code: -32602, message: "invalid params" } })
      const stop = setup({ a: { getSlot: rejected }, b: { getSlot: slot(7) } })
      expect((yield* stop.run((rpc) => Effect.flip(rpc.getSlot(confirmed)))).reason).toBe("Rejected")
      expect(stop.calls).toStrictEqual(["a:getGenesisHash", "a:getSlot"])
    }))

  it.effect("fails with the last error and keeps the others when every endpoint fails", () =>
    Effect.gen(function*() {
      const { run } = setup({
        a: { getSlot: () => new Response("down", { status: 503 }) },
        b: { getSlot: () => ({ result: "nope" }) }
      })
      const error = yield* run((rpc) => Effect.flip(rpc.getSlot(confirmed)))
      expect(error).toMatchObject({ reason: "InvalidResponse", endpoint: "b" })
      assert.instanceOf(error.cause, AggregateError)
      expect(error.cause.errors).toMatchObject([{ endpoint: "a", reason: "Unavailable", code: 503 }, { endpoint: "b" }])
    }))

  it.effect("falls back after an invalid response and succeeds on the next endpoint", () => {
    const { calls, run } = setup({ a: { getSlot: () => ({ result: "twenty" }) }, b: { getSlot: slot(7) } })
    return run((rpc) => rpc.getSlot(confirmed)).pipe(Effect.map((value) => {
      expect(value).toBe(BigInt(7))
      expect(calls).toStrictEqual(["a:getGenesisHash", "a:getSlot", "b:getGenesisHash", "b:getSlot"])
    }))
  })

  it.effect("checks the network once per endpoint and caches a mismatch", () =>
    Effect.gen(function*() {
      const ok = setup({ a: { getSlot: slot(1) } })
      yield* ok.run((rpc) => Effect.zip(rpc.getSlot(confirmed), rpc.getSlot(confirmed)))
      expect(ok.calls).toStrictEqual(["a:getGenesisHash", "a:getSlot", "a:getSlot"])

      const devnet = () => ({ result: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" })
      const wrong = setup({ a: { getGenesisHash: devnet, getSlot: slot(1) }, b: {} })
      const errors = yield* wrong.run((rpc) =>
        Effect.zip(Effect.flip(rpc.getSlot(confirmed)), Effect.flip(rpc.getSlot(confirmed)))
      )
      expect(errors.map((error) => error.reason)).toStrictEqual(["WrongNetwork", "WrongNetwork"])
      expect(wrong.calls).toStrictEqual(["a:getGenesisHash"])
    }))

  it.effect("does not cache a failed network check", () => {
    let attempts = 0
    const { calls, run } = setup({
      a: {
        getGenesisHash: () => ++attempts === 1 ? new Response("down", { status: 503 }) : { result: MAINNET_GENESIS },
        getSlot: slot(1)
      }
    })
    return run((rpc) => Effect.zip(Effect.flip(rpc.getSlot(confirmed)), rpc.getSlot(confirmed))).pipe(
      Effect.map(([error]) => {
        expect(error.reason).toBe("Unavailable")
        expect(calls).toStrictEqual(["a:getGenesisHash", "a:getGenesisHash", "a:getSlot"])
      })
    )
  })

  it.effect("runs one network check for concurrent first calls", () => {
    const { calls, run } = setup({ a: { getSlot: slot(1) } })
    return run((rpc) => Effect.all(Arr.replicate(rpc.getSlot(confirmed), 3), { concurrency: "unbounded" })).pipe(
      Effect.map(() => expect(calls).toStrictEqual(["a:getGenesisHash", "a:getSlot", "a:getSlot", "a:getSlot"]))
    )
  })

  // live clock: the retry backoff sleeps for real
  it.live("retries transient errors before falling back", () => {
    let attempts = 0
    const { calls, run } = setup({
      a: {
        getSlot: () =>
          ++attempts === 2 ? { error: { code: -32005, message: "node is unhealthy" } } : new Response("busy", {
            status: 503
          })
      },
      b: { getSlot: slot(7) }
    }, { retries: 2 })
    return run((rpc) => rpc.getSlot(confirmed)).pipe(Effect.map((value) => {
      expect(value).toBe(BigInt(7))
      expect(calls).toStrictEqual([
        "a:getGenesisHash",
        "a:getSlot",
        "a:getSlot",
        "a:getSlot",
        "b:getGenesisHash",
        "b:getSlot"
      ])
    }))
  })

  it.live("waits for Retry-After", () =>
    Effect.gen(function*() {
      let attempts = 0
      const { calls, run } = setup({
        a: {
          getSlot: () =>
            ++attempts === 1 ? new Response("slow down", { status: 429, headers: { "retry-after": "1" } }) : {
              result: 5
            }
        }
      }, { retries: 1 })
      const start = yield* Clock.currentTimeMillis
      expect(yield* run((rpc) => rpc.getSlot(confirmed))).toBe(BigInt(5))
      expect((yield* Clock.currentTimeMillis) - start).toBeGreaterThanOrEqual(1000)
      expect(calls).toStrictEqual(["a:getGenesisHash", "a:getSlot", "a:getSlot"])
    }))

  it.effect("does not retry a 403 and falls back", () => {
    const { calls, run } = setup({
      a: { getSlot: () => new Response("forbidden", { status: 403 }) },
      b: { getSlot: slot(7) }
    }, { retries: 2 })
    return run((rpc) => rpc.getSlot(confirmed)).pipe(Effect.map((value) => {
      expect(value).toBe(BigInt(7))
      expect(calls).toStrictEqual(["a:getGenesisHash", "a:getSlot", "b:getGenesisHash", "b:getSlot"])
    }))
  })

  const failure = (reply: Node[string], options?: { readonly timeout?: Duration.Input }) =>
    setup({ a: { getSlot: reply } }, options).run((rpc) => Effect.flip(rpc.getSlot(confirmed)))

  it.effect("classifies HTTP 429 and 503 as Unavailable", () =>
    Effect.gen(function*() {
      for (const status of [429, 503]) {
        const error = yield* failure(() => new Response("busy", { status }))
        expect(error).toMatchObject({ reason: "Unavailable", code: status, method: "getSlot", endpoint: "a" })
      }
    }))

  // live clock: the timeout sleeps for real
  it.live("classifies a timeout and a transport error as Unavailable", () =>
    Effect.gen(function*() {
      // like fetch, hang until aborted
      const hang: Node[string] = (_, signal) =>
        new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason)))
      expect((yield* failure(hang, { timeout: "20 millis" })).reason).toBe("Unavailable")
      expect((yield* failure(() => Promise.reject(new TypeError("fetch failed")))).reason).toBe("Unavailable")
    }))

  it.effect("classifies JSON-RPC codes", () =>
    Effect.gen(function*() {
      const cases: ReadonlyArray<readonly [number, SolanaRpc.SolanaRpcErrorReason]> = [
        [-32602, "Rejected"],
        [429, "Unavailable"],
        [-32005, "Unavailable"],
        [-32603, "Unavailable"],
        [-32019, "Unavailable"],
        [-32016, "Lagging"],
        [-32004, "Lagging"],
        [-32014, "Lagging"],
        [-32001, "Pruned"],
        [-32007, "Pruned"],
        [-32009, "Pruned"],
        [-32011, "Pruned"],
        [-32010, "Pruned"]
      ]
      for (const [code, reason] of cases) {
        const error = yield* failure(() => ({ error: { code, message: "no" } }))
        expect(error, String(code)).toMatchObject({ reason, code })
      }
    }))

  it.effect("classifies an invalid result or a non-JSON body as InvalidResponse", () =>
    Effect.gen(function*() {
      expect((yield* failure(() => ({ result: "twenty" }))).reason).toBe("InvalidResponse")
      expect((yield* failure(() => ({ result: 1.5 }))).reason).toBe("InvalidResponse")
      expect((yield* failure(() => new Response("<html>"))).reason).toBe("InvalidResponse")
    }))

  it.effect("fails Rejected without a request when params do not encode", () => {
    const { calls, run } = setup({ a: {}, b: {} })
    return run((rpc) => Effect.flip(rpc.getSignaturesForAddress({ address: ADDRESS, limit: 1.5, ...confirmed }))).pipe(
      Effect.map((error) => {
        expect(error).toMatchObject({ reason: "Rejected", method: "getSignaturesForAddress", endpoint: "a" })
        // only the endpoint's network check went out
        expect(calls).toStrictEqual(["a:getGenesisHash"])
      })
    )
  })

  it.effect("keeps the URL out of errors", () =>
    Effect.gen(function*() {
      for (
        const reply of [
          () => new Response("busy", { status: 503 }),
          () => ({ error: { code: -32602, message: "no" } }),
          () => new Response("<html>"),
          () => Promise.reject(new TypeError("fetch failed: https://a.rpc.test/secret-key"))
        ]
      ) {
        const error = yield* failure(reply)
        assert.instanceOf(error.cause, Error)
        for (const item of causeChain(error)) {
          expect(`${item.message} ${item.stack} ${JSON.stringify(item)}`).not.toContain("secret-key")
        }
      }
    }))

  it.effect("records one span per request without the URL", () => {
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      }
    })
    return setup({ a: { getSlot: slot(1) } }).run((rpc) => rpc.getSlot(confirmed)).pipe(
      Effect.withTracer(tracer),
      Effect.map(() => {
        expect(spans.map((span) => [span.name, Object.fromEntries(span.attributes)])).toStrictEqual([
          ["SolanaRpc.getGenesisHash", { network: "Solana", endpoint: "a", method: "getGenesisHash" }],
          ["SolanaRpc.getSlot", { network: "Solana", endpoint: "a", method: "getSlot" }]
        ])
        expect(JSON.stringify(spans.map((span) => [span.name, [...span.attributes]]))).not.toContain("secret-key")
      })
    )
  })
})
