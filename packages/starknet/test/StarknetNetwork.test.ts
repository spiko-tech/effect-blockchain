import { StarknetNetwork, starknetNetworks } from "@effect-blockchain/starknet/StarknetNetwork"
import { describe, expect, it } from "@effect/vitest"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

describe("StarknetNetwork", () => {
  it("decodes known networks", () => {
    expect(Schema.decodeUnknownSync(StarknetNetwork)("Starknet")).toBe("Starknet")
    expect(Schema.decodeUnknownSync(StarknetNetwork)("StarknetSepolia")).toBe("StarknetSepolia")
  })

  it("rejects unknown networks", () => {
    expect(Result.isFailure(Schema.decodeUnknownResult(StarknetNetwork)("Ethereum"))).toBe(true)
  })

  it("tags mainnet and testnet with their chain identifier", () => {
    expect(starknetNetworks.Starknet).toStrictEqual({ name: "Starknet", chainId: "SN_MAIN", type: "mainnet" })
    expect(starknetNetworks.StarknetSepolia).toStrictEqual({
      name: "Starknet Sepolia",
      chainId: "SN_SEPOLIA",
      type: "testnet"
    })
  })
})
