import { EvmHexData } from "@effect-blockchain/evm/EvmHexData"
import { describe, expect, it } from "@effect/vitest"
import * as Arbitrary from "effect/Arbitrary"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

describe("EvmHexData", () => {
  it("decodes even-length hex, including the empty payload", () => {
    expect(Schema.decodeSync(EvmHexData)("0xa9059cbb")).toBe("0xa9059cbb")
    expect(Schema.decodeSync(EvmHexData)("0x")).toBe("0x")
  })

  it("normalizes to lowercase", () => {
    expect(Schema.decodeSync(EvmHexData)("0xA9059CBB")).toBe("0xa9059cbb")
    expect(Schema.decodeSync(EvmHexData)("0X12")).toBe("0x12")
  })

  it("rejects invalid hex data", () => {
    for (const input of ["a9059cbb", "0xabc", "0xzz", ""]) {
      expect(Result.isFailure(Schema.decodeUnknownResult(EvmHexData)(input))).toBe(true)
    }
  })

  it("round trips through encode", () => {
    expect(Schema.encodeSync(EvmHexData)(Schema.decodeSync(EvmHexData)("0xa9059cbb"))).toBe("0xa9059cbb")
  })

  it("arbitrary generates decodable hex data", () => {
    const samples = Effect.runSync(Arbitrary.sampleEffect(Arbitrary.schema(EvmHexData), { count: 10 }))
    for (const sample of samples) {
      expect(Schema.decodeSync(EvmHexData)(sample)).toBe(sample)
    }
  })
})
