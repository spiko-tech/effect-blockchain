import {
  isTestnet,
  mainnets,
  networks,
  StarknetChainId,
  StarknetNetwork,
  testnets,
  toChainId
} from "@effect-blockchain/starknet/StarknetNetwork"
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

  it("maps each network to its chain ID and testnet tag", () => {
    expect(networks.map(toChainId)).toStrictEqual(["SN_MAIN", "SN_SEPOLIA"])
    expect(networks.map(isTestnet)).toStrictEqual([false, true])
    expect(networks.length).toBe(mainnets.length + testnets.length)
  })
})

describe("StarknetChainId", () => {
  it("accepts known chain IDs and rejects the rest", () => {
    expect(Schema.decodeUnknownSync(StarknetChainId)("SN_MAIN")).toBe("SN_MAIN")
    expect(Result.isFailure(Schema.decodeUnknownResult(StarknetChainId)("SN_GOERLI"))).toBe(true)
  })
})
