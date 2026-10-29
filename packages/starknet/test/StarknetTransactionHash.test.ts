import { StarknetTransactionHash } from "@effect-blockchain/starknet/StarknetTransactionHash"
import { describe, expect, it } from "@effect/vitest"
import * as Arbitrary from "effect/Arbitrary"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

const decode = Schema.decodeUnknownResult(StarknetTransactionHash)

describe("StarknetTransactionHash", () => {
  it("decodes a valid hash", () => {
    const hash = "0xc9357f82160b5bd54a1929afde799e180a611a5570c9c502d5bde4e511a267bf"
    expect(decode(hash)).toStrictEqual(Result.succeed(hash))
  })

  it("lowercases the hash", () => {
    expect(
      Schema.decodeSync(StarknetTransactionHash)("0xc9357F82160b5bd54a1929aFDE799e180a611a5570c9c502d5bde4e511a267bf")
    )
      .toBe("0xc9357f82160b5bd54a1929afde799e180a611a5570c9c502d5bde4e511a267bf")
  })

  it("left-pads a short hash", () => {
    expect(decode("0xc9")).toStrictEqual(
      Result.succeed("0x00000000000000000000000000000000000000000000000000000000000000c9")
    )
  })

  it.each(["wrong-hash", "", "0x", "0x1c9357f82160b5bd54a1929afde799e180a611a5570c9c502d5bde4e511a267bf"])(
    "rejects %j",
    (input) => {
      expect(Result.isFailure(decode(input))).toBe(true)
    }
  )

  it("encodes back to the normalized string", () => {
    const hash = Schema.decodeSync(StarknetTransactionHash)("0xC9")
    expect(Schema.encodeSync(StarknetTransactionHash)(hash)).toBe(
      "0x00000000000000000000000000000000000000000000000000000000000000c9"
    )
  })

  it("arbitrary generates valid hashes", () => {
    const result = Effect.runSync(
      Arbitrary.checkEffect(
        Arbitrary.schema(StarknetTransactionHash),
        (hash) => Schema.is(StarknetTransactionHash)(hash)
      )
    )
    expect(Arbitrary.formatCheckFailure(result)).toBeUndefined()
  })
})
