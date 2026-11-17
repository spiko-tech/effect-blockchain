import { describe, expect, it } from "@effect/vitest"
import * as Schema from "effect/Schema"
import { readFileSync } from "node:fs"
import { parse } from "../src/internal/bigIntJson.ts"
import * as RpcMethods from "../src/internal/rpcMethods.ts"

// a v0 swap recorded in `json`: inner instructions, token balances, logs, rewards
const swapBody: string = JSON.parse(
  readFileSync(new URL("fixtures/alchemy/getTransaction-v0-json.json", import.meta.url), "utf8")
).body
const Reply = Schema.Struct({ result: RpcMethods.getTransaction("json").result })
// integers as decimal strings on both sides, so that a `bigint` equals the JSON number it was read from
const normalize = (value: object | null) =>
  JSON.parse(
    JSON.stringify(value, (_key, item) => typeof item === "bigint" ? String(item) : item),
    (_key, item) => Number.isInteger(item) ? String(item) : item
  )

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

  it("keeps every field of the transaction meta, typing the inner instructions and token balances", () => {
    const raw = JSON.parse(swapBody).result.meta
    const reply = Schema.decodeUnknownSync(Reply)(parse(swapBody))
    const meta = reply.result?.meta
    expect(Object.keys(meta ?? {}).sort()).toStrictEqual(Object.keys(raw).sort())
    expect(meta?.innerInstructions?.[0]?.index).toBe(4)
    expect(meta?.innerInstructions?.[0]?.instructions[0]).toMatchObject({ programIdIndex: 26, stackHeight: 2 })
    expect(meta?.preTokenBalances).toHaveLength(9)
    expect(meta?.preTokenBalances?.[0]).toStrictEqual({
      accountIndex: 3,
      mint: "9LBeAW3McsaiNEjFHi1PLUvg4g3obginXq7WF4YXpump",
      owner: "FjLjHwDM1YJhoghyNSP9CEikMopsYinYFvTvACmgH9Ci",
      programId: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
      uiTokenAmount: {
        amount: BigInt("39011922717"),
        decimals: 6,
        uiAmount: 39011.922717,
        uiAmountString: "39011.922717"
      }
    })
    expect(meta?.postTokenBalances?.[0]?.uiTokenAmount).toMatchObject({ amount: BigInt(0), uiAmount: null })
    expect(meta?.computeUnitsConsumed).toBe("106676")
    expect(meta?.logMessages).toHaveLength(37)
    expect(meta?.status).toStrictEqual({ Ok: null })
    expect(normalize(Schema.encodeSync(Reply)(reply).result?.meta ?? null)).toStrictEqual(normalize(raw))
  })
})
