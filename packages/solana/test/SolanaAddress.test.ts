import { SolanaAddress, SYSTEM_PROGRAM_ADDRESS } from "@effect-blockchain/solana/SolanaAddress"
import { describe, expect, it } from "@effect/vitest"
import * as Arbitrary from "effect/Arbitrary"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

describe("SolanaAddress", () => {
  it("decodes a valid address", () => {
    const address = "J6HCmUiVaKUfPAujRmXrXx8xhPJSoizbMZn3XP18id8F"
    expect(Schema.decodeResult(SolanaAddress)(address)).toStrictEqual(Result.succeed(address))
  })

  it("decodes the system program address", () => {
    expect(Schema.decodeResult(SolanaAddress)(SYSTEM_PROGRAM_ADDRESS)).toStrictEqual(
      Result.succeed("11111111111111111111111111111111")
    )
  })

  it("encodes back to the same string", () => {
    expect(Schema.encodeSync(SolanaAddress)(SYSTEM_PROGRAM_ADDRESS)).toBe("11111111111111111111111111111111")
  })

  it("rejects an invalid address", () => {
    for (const address of ["invalid-address", "", "0x0000000000000000000000000000000000000000"]) {
      expect(Schema.decodeResult(SolanaAddress)(address)).toStrictEqual(
        Result.fail(expect.objectContaining({ _tag: "SchemaError" }))
      )
    }
  })

  it("arbitrary generates valid addresses", () => {
    const samples = Effect.runSync(Arbitrary.sampleEffect(Arbitrary.schema(SolanaAddress), { count: 10 }))
    expect(samples.every(Schema.is(SolanaAddress))).toBe(true)
  })
})
