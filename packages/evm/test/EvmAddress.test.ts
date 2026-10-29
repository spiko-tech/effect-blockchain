import { EvmAddress, NULL_ADDRESS, toEip55 } from "@effect-blockchain/evm/EvmAddress"
import { describe, expect, it } from "@effect/vitest"
import * as Arbitrary from "effect/Arbitrary"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

const checksummed = "0xC2EEdC5C6E63d122E3eF312b55B87E657Be4744F"
const lowercase = "0xc2eedc5c6e63d122e3ef312b55b87e657be4744f"

describe("EvmAddress", () => {
  it("decodes a checksummed address to lowercase", () => {
    expect(Schema.decodeSync(EvmAddress)(checksummed)).toBe(lowercase)
  })

  it("rejects invalid addresses", () => {
    for (
      const input of [
        "wrong-address",
        "0x1234",
        lowercase.slice(2),
        `${lowercase}00`,
        "0xZ2eedc5c6e63d122e3ef312b55b87e657be4744f"
      ]
    ) {
      expect(Result.isFailure(Schema.decodeUnknownResult(EvmAddress)(input))).toBe(true)
    }
  })

  it("round trips through encode", () => {
    const address = Schema.decodeSync(EvmAddress)(checksummed)
    expect(Schema.encodeSync(EvmAddress)(address)).toBe(lowercase)
  })

  it("arbitrary generates decodable addresses", () => {
    const samples = Effect.runSync(Arbitrary.sampleEffect(Arbitrary.schema(EvmAddress), { count: 10 }))
    for (const sample of samples) {
      expect(Schema.decodeSync(EvmAddress)(sample)).toBe(sample)
    }
  })

  it("NULL_ADDRESS is the zero address", () => {
    expect(NULL_ADDRESS).toBe("0x0000000000000000000000000000000000000000")
  })

  it("toEip55 returns the checksum form", () => {
    expect(toEip55(Schema.decodeSync(EvmAddress)(lowercase))).toBe(checksummed)
  })
})
