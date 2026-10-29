import { StellarTransactionHash } from "@effect-blockchain/stellar/StellarTransactionHash"
import { describe, expect, it } from "@effect/vitest"
import * as Arbitrary from "effect/Arbitrary"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

const hash = "0x3ffa0af07c4401bfdd7b16b80e00b719cf82c0c4f00c70021da0fba8d1e5d029"

describe("StellarTransactionHash", () => {
  it("should decode a valid stellar transaction hash", () => {
    expect(Schema.decodeSync(StellarTransactionHash)(hash)).toStrictEqual(hash)
  })

  it("should decode a valid stellar transaction hash and add 0x prefix", () => {
    expect(Schema.decodeSync(StellarTransactionHash)(hash.slice(2))).toStrictEqual(hash)
  })

  it("should lower-case the input", () => {
    expect(Schema.decodeSync(StellarTransactionHash)(hash.slice(2).toUpperCase())).toStrictEqual(hash)
  })

  it("should round trip through encode", () => {
    const decoded = Schema.decodeSync(StellarTransactionHash)(hash)
    expect(Schema.encodeSync(StellarTransactionHash)(decoded)).toBe(hash)
  })

  it("should fail decoding a wrong stellar transaction hash", () => {
    expect(Schema.decodeResult(StellarTransactionHash)(hash.slice(3))).toStrictEqual(
      Result.fail(expect.objectContaining({ _tag: "SchemaError" }))
    )
    expect(Schema.decodeResult(StellarTransactionHash)(`${hash.slice(0, -1)}g`)).toStrictEqual(
      Result.fail(expect.objectContaining({ _tag: "SchemaError" }))
    )
  })

  it.effect("should generate decodable values", () =>
    Effect.gen(function*() {
      const samples = yield* Arbitrary.sampleEffect(Arbitrary.schema(StellarTransactionHash))
      for (const sample of samples) {
        expect(Schema.decodeSync(StellarTransactionHash)(sample)).toBe(sample)
      }
    }))
})
