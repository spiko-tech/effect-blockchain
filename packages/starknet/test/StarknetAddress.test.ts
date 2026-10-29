import { NullStarknetAddress, StarknetAddress } from "@effect-blockchain/starknet/StarknetAddress"
import { describe, expect, it } from "@effect/vitest"
import * as Arbitrary from "effect/Arbitrary"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

const decode = Schema.decodeUnknownResult(StarknetAddress)

describe("StarknetAddress", () => {
  it("decodes a valid address", () => {
    const address = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    expect(decode(address)).toStrictEqual(Result.succeed(address))
  })

  it("lowercases the address", () => {
    expect(Schema.decodeSync(StarknetAddress)("0x0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF"))
      .toBe("0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
  })

  it("left-pads a short address", () => {
    expect(decode("0x32")).toStrictEqual(
      Result.succeed("0x0000000000000000000000000000000000000000000000000000000000000032")
    )
    expect(decode("0x0")).toStrictEqual(Result.succeed(NullStarknetAddress))
  })

  it("accepts an address without the 0x prefix", () => {
    expect(decode("32")).toStrictEqual(
      Result.succeed("0x0000000000000000000000000000000000000000000000000000000000000032")
    )
  })

  it.each([
    "wrong-address",
    "",
    "0x",
    "0xzz",
    "0x10123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    42
  ])("rejects %j", (input) => {
    expect(Result.isFailure(decode(input))).toBe(true)
  })

  it("encodes back to the normalized string", () => {
    const address = Schema.decodeSync(StarknetAddress)("0xABC")
    expect(Schema.encodeSync(StarknetAddress)(address)).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000abc"
    )
  })

  it("arbitrary generates valid addresses", () => {
    const result = Effect.runSync(
      Arbitrary.checkEffect(Arbitrary.schema(StarknetAddress), (address) => Schema.is(StarknetAddress)(address))
    )
    expect(Arbitrary.formatCheckFailure(result)).toBeUndefined()
  })
})
