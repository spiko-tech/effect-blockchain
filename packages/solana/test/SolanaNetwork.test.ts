import {
  isTestnet,
  mainnets,
  networks,
  SolanaNetwork,
  testnets,
  toGenesisHash
} from "@effect-blockchain/solana/SolanaNetwork"
import { describe, expect, it } from "@effect/vitest"
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
})
