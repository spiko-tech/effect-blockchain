import {
  defaultConfirmations,
  isTestnet,
  mainnets,
  networks,
  SolanaGenesisHash,
  SolanaNetwork,
  testnets,
  toGenesisHash
} from "@effect-blockchain/solana/SolanaNetwork"
import { describe, expect, it } from "@effect/vitest"
import * as Arbitrary from "effect/Arbitrary"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

describe("SolanaNetwork", () => {
  it("decodes every named network", () => {
    for (const network of ["Solana", "SolanaDevnet", "SolanaTestnet"]) {
      expect(Schema.decodeUnknownResult(SolanaNetwork)(network)).toStrictEqual(Result.succeed(network))
    }
  })

  it("rejects an unknown network", () => {
    expect(Schema.decodeUnknownResult(SolanaNetwork)("Ethereum")).toStrictEqual(
      Result.fail(expect.objectContaining({ _tag: "SchemaError" }))
    )
    expect(Schema.is(SolanaNetwork)("solana")).toBe(false)
  })

  it("tags mainnet and testnets", () => {
    expect(networks.map(isTestnet)).toStrictEqual([false, true, true])
    expect(networks.length).toBe(mainnets.length + testnets.length)
  })

  it("has a distinct genesis hash per network", () => {
    expect(toGenesisHash("Solana")).toBe("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d")
    expect(new Set(networks.map(toGenesisHash)).size).toBe(networks.length)
  })

  it("decodes every genesis hash as a SolanaGenesisHash", () => {
    for (const network of networks) {
      expect(Schema.decodeResult(SolanaGenesisHash)(toGenesisHash(network))).toStrictEqual(
        Result.succeed(toGenesisHash(network))
      )
    }
  })

  it("rejects an invalid genesis hash", () => {
    for (const value of ["invalid-hash", "0".repeat(44), "1111"]) {
      expect(Schema.decodeResult(SolanaGenesisHash)(value)).toStrictEqual(
        Result.fail(expect.objectContaining({ _tag: "SchemaError" }))
      )
    }
  })

  it("has no default confirmations: the indexer reads finalized slots", () => {
    expect(networks.map(defaultConfirmations)).toStrictEqual([0, 0, 0])
  })

  it("arbitrary generates valid genesis hashes", () => {
    const samples = Effect.runSync(Arbitrary.sampleEffect(Arbitrary.schema(SolanaGenesisHash), { count: 10 }))
    expect(samples.every(Schema.is(SolanaGenesisHash))).toBe(true)
  })
})
