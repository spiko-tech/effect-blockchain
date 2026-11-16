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

  it("decodes a transaction error, keeping the variants it does not model as raw JSON", () => {
    const decode = (err: unknown) =>
      Schema.decodeUnknownSync(RpcMethods.getSignatureStatuses.result)({
        context: { slot: BigInt(9) },
        value: [{ slot: BigInt(1), confirmations: BigInt(3), err, confirmationStatus: "confirmed", status: {} }]
      }).value[0]
    expect(decode(null)).toStrictEqual({
      slot: BigInt(1),
      confirmations: 3,
      err: null,
      confirmationStatus: "confirmed"
    })
    expect(decode("BlockhashNotFound")?.err).toBe("BlockhashNotFound")
    expect(decode({ InstructionError: [BigInt(2), { Custom: BigInt(6001) }] })?.err).toStrictEqual({
      InstructionError: [2, { Custom: 6001 }]
    })
    expect(decode({ InstructionError: [BigInt(0), "InvalidArgument"] })?.err).toStrictEqual({
      InstructionError: [0, "InvalidArgument"]
    })
    expect(decode({ InstructionError: [BigInt(0), { BorshIoError: "eof" }] })?.err).toStrictEqual({
      InstructionError: [0, { BorshIoError: "eof" }]
    })
    expect(decode({ InsufficientFundsForRent: { account_index: BigInt(4) } })?.err).toStrictEqual({
      InsufficientFundsForRent: { account_index: "4" }
    })
  })
})
