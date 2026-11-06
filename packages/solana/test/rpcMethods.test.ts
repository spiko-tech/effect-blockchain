import { describe, expect, it } from "@effect/vitest"
import * as Schema from "effect/Schema"
import * as RpcMethods from "../src/internal/rpcMethods.ts"

describe("rpcMethods", () => {
  it("encodes a raw JSON field back as it was decoded", () => {
    const entry = {
      signature: "2ijR446DGZ3zFMDdp5JrbonSpRwrvN4bGK7oGiLpn5DpR9eCFHZjMPh89feRiuygcVhhY6HxP64y5xtnVfKJutz1",
      slot: BigInt(1),
      blockTime: null,
      err: { InstructionError: ["0", { Custom: "1" }] },
      memo: null
    }
    expect(Schema.encodeUnknownSync(RpcMethods.getSignaturesForAddress.result)([entry])).toStrictEqual([entry])
  })
})
