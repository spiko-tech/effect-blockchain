import { SolanaAddress } from "@effect-blockchain/solana/SolanaAddress"
import * as SolanaRpc from "@effect-blockchain/solana/SolanaRpc"
import { SolanaTransactionHash } from "@effect-blockchain/solana/SolanaTransactionHash"
import { describe, expect, it } from "@effect/vitest"
import * as Arr from "effect/Array"
import * as Config from "effect/Config"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import type * as Schema from "effect/Schema"

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
const setup = (nodes: Record<string, Node>) => {
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
  const endpoints = Arr.map(names, (name) => ({ name, url: Redacted.make(`https://${name}.rpc.test/secret-key`) }))
  const layer = SolanaRpc.layer({ network: "Solana", endpoints, retries: 0 }).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))
  )
  const run = <A, E>(f: (rpc: SolanaRpc.SolanaRpc["Service"]) => Effect.Effect<A, E>) =>
    Effect.gen(function*() {
      return yield* f(yield* SolanaRpc.SolanaRpc)
    }).pipe(Effect.provide(layer))
  return { calls, fetch, run }
}

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
        expect(error.message).toBe("getTransaction failed on a: Pruned")
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

  it.effect("maps the chain error codes to reasons", () =>
    Effect.gen(function*() {
      const cases: ReadonlyArray<readonly [number, SolanaRpc.SolanaRpcErrorReason]> = [
        [429, "Unavailable"],
        [-32603, "Unavailable"],
        [-32005, "Unavailable"],
        [-32019, "Unavailable"],
        [-32016, "Lagging"],
        [-32004, "Lagging"],
        [-32014, "Lagging"],
        [-32001, "Pruned"],
        [-32007, "Pruned"],
        [-32009, "Pruned"],
        [-32011, "Pruned"],
        [-32010, "Pruned"],
        [-32602, "Rejected"]
      ]
      for (const [code, reason] of cases) {
        const error = yield* setup({ a: { getSlot: () => ({ error: { code, message: "no" } }) } }).run((rpc) =>
          Effect.flip(rpc.getSlot(confirmed))
        )
        expect(error, String(code)).toMatchObject({ reason, code, method: "getSlot", endpoint: "a" })
        expect(error.message).toBe(`getSlot failed on a: ${reason} (${code})`)
      }
    }))

  it.effect("fails WrongNetwork on a network mismatch", () => {
    const devnet = () => ({ result: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" })
    const { calls, run } = setup({ a: { getGenesisHash: devnet, getSlot: slot(1) }, b: {} })
    return run((rpc) => Effect.flip(rpc.getSlot(confirmed))).pipe(Effect.map((error) => {
      expect(error).toMatchObject({ reason: "WrongNetwork", method: "getGenesisHash", endpoint: "a" })
      expect(calls).toStrictEqual(["a:getGenesisHash"])
    }))
  })

  it.effect("falls back to the next endpoint through the layer", () => {
    const { calls, run } = setup({
      a: { getSlot: () => new Response("down", { status: 503 }) },
      b: { getSlot: slot(7) }
    })
    return run((rpc) => rpc.getSlot(confirmed)).pipe(Effect.map((value) => {
      expect(value).toBe(BigInt(7))
      expect(calls).toStrictEqual(["a:getGenesisHash", "a:getSlot", "b:getGenesisHash", "b:getSlot"])
    }))
  })
})

describe("layerConfig", () => {
  const endpoints = Config.all([Config.all({ name: Config.succeed("a"), url: Config.Redacted("SOLANA_RPC_URL") })])
  const run = (env: Record<string, string>) => {
    const { calls, fetch } = setup({ a: { getSlot: slot(300) } })
    const layer = SolanaRpc.layerConfig({ network: Config.succeed("Solana"), endpoints, retries: Config.succeed(0) })
      .pipe(
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env)))
      )
    return {
      calls,
      effect: Effect.gen(function*() {
        return yield* (yield* SolanaRpc.SolanaRpc).getSlot(confirmed)
      }).pipe(Effect.provide(layer))
    }
  }

  it.effect("builds from config", () =>
    Effect.gen(function*() {
      const { calls, effect } = run({ SOLANA_RPC_URL: "https://a.rpc.test/secret-key" })
      expect(yield* effect).toStrictEqual(BigInt(300))
      expect(calls.length).toBeGreaterThan(0)
    }))

  it.effect("fails with a ConfigError when a value is missing", () =>
    Effect.gen(function*() {
      const { calls, effect } = run({})
      expect(yield* Effect.flip(effect)).toMatchObject({ _tag: "ConfigError" })
      expect(calls).toStrictEqual([])
    }))

  it("keeps the endpoint url redacted", () => {
    SolanaRpc.layerConfig({
      network: Config.succeed("Solana"),
      // @ts-expect-error a plain string url is rejected
      endpoints: Config.all([Config.all({ name: Config.succeed("a"), url: Config.String("SOLANA_RPC_URL") })])
    })
  })
})
