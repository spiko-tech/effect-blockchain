import { SolanaTransactionHash } from "@effect-blockchain/solana/SolanaTransactionHash"
import { describe, expect, it } from "@effect/vitest"
import * as Arbitrary from "effect/Arbitrary"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

const hash = "5UfDuX7WXYZdgnWkLhKnga5PsaFdMNQdi5SBPYB4RY5UBbQDN3kQz3VEABDaGbNkYPhGMaFKaLwUMcnMnEHG77v"

describe("SolanaTransactionHash", () => {
  it("decodes a valid transaction hash", () => {
    expect(Schema.decodeResult(SolanaTransactionHash)(hash)).toStrictEqual(Result.succeed(hash))
  })

  it("encodes back to the same string", () => {
    expect(Schema.encodeSync(SolanaTransactionHash)(SolanaTransactionHash.make(hash))).toBe(hash)
  })

  it("rejects an invalid transaction hash", () => {
    expect(Schema.decodeResult(SolanaTransactionHash)("invalid-hash")).toStrictEqual(
      Result.fail(expect.objectContaining({ _tag: "SchemaError" }))
    )
  })

  it("fails gracefully on non-base58 characters instead of throwing", () => {
    const value = "0x 2191fda9a64fdef38eb14c544333b7aa21f533c3ddd8b2f998af1775442681e0"
    expect(Schema.decodeResult(SolanaTransactionHash)(value)).toStrictEqual(
      Result.fail(expect.objectContaining({ _tag: "SchemaError" }))
    )
  })

  it("arbitrary generates valid transaction hashes", () => {
    const samples = Effect.runSync(Arbitrary.sampleEffect(Arbitrary.schema(SolanaTransactionHash), { count: 10 }))
    expect(samples.every(Schema.is(SolanaTransactionHash))).toBe(true)
  })
})
