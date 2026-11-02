import { describe, expect, it } from "@effect/vitest"
import * as BigIntJson from "../src/internal/bigIntJson.ts"

describe("bigIntJson", () => {
  it("parses integers as exact bigints and keeps decimals as numbers", () => {
    expect(BigIntJson.parse(`{"a":[18446744073709551615,-3,0],"b":1.5,"c":1e3,"d":"7"}`)).toStrictEqual({
      a: [BigInt("18446744073709551615"), BigInt(-3), BigInt(0)],
      b: 1.5,
      c: 1000,
      d: "7"
    })
  })
})
