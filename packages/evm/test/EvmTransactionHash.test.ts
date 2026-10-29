import { EvmTransactionHash } from "@effect-blockchain/evm/EvmTransactionHash"
import { describe, expect, it } from "@effect/vitest"
import * as Arbitrary from "effect/Arbitrary"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

const hash = "0xc9357f82160b5bd54a1929afde799e180a611a5570c9c502d5bde4e511a267bf"

describe("EvmTransactionHash", () => {
  it("decodes a valid hash", () => {
    expect(Schema.decodeSync(EvmTransactionHash)(hash)).toBe(hash)
  })

  it("normalizes to lowercase", () => {
    expect(Schema.decodeSync(EvmTransactionHash)("0xc9357F82160b5bd54a1929aFDE799e180a611a5570c9c502d5bde4e511a267bf"))
      .toBe(hash)
  })

  it("rejects invalid hashes", () => {
    for (const input of ["wrong-hash", hash.slice(0, -2), `${hash}00`, hash.slice(2), `0xg${hash.slice(3)}`]) {
      expect(Result.isFailure(Schema.decodeUnknownResult(EvmTransactionHash)(input))).toBe(true)
    }
  })

  it("round trips through encode", () => {
    expect(Schema.encodeSync(EvmTransactionHash)(Schema.decodeSync(EvmTransactionHash)(hash))).toBe(hash)
  })

  it("arbitrary generates decodable hashes", () => {
    const samples = Effect.runSync(Arbitrary.sampleEffect(Arbitrary.schema(EvmTransactionHash), { count: 10 }))
    for (const sample of samples) {
      expect(Schema.decodeSync(EvmTransactionHash)(sample)).toBe(sample)
    }
  })
})
