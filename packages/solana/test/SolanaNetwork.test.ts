import {
  defaultConfirmations,
  isSolanaNetwork,
  SOLANA_NETWORK_KINDS,
  SolanaNetwork
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
    expect(isSolanaNetwork("solana")).toBe(false)
  })

  it("tags mainnet and testnets", () => {
    expect(SOLANA_NETWORK_KINDS).toStrictEqual({
      Solana: "mainnet",
      SolanaDevnet: "testnet",
      SolanaTestnet: "testnet"
    })
  })

  it("has default confirmations per network", () => {
    expect(defaultConfirmations("Solana")).toBe(32)
    expect(defaultConfirmations("SolanaDevnet")).toBe(0)
    expect(defaultConfirmations("SolanaTestnet")).toBe(0)
  })
})
