import {
  NULL_STELLAR_ADDRESS,
  StellarAccountAddress,
  StellarAddress,
  StellarContractAddress
} from "@effect-blockchain/stellar/StellarAddress"
import { describe, expect, it } from "@effect/vitest"
import { contract } from "@stellar/stellar-sdk"
import * as Arbitrary from "effect/Arbitrary"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

const account = "GBYIQXBKEB655EB3WTRITS6RR5GXEP6SQRBLPREZHNFYKT7WBMTMPR3H"
const contractAddress = "CCAANR7HZNOXYZD7SXS2WQLV5BAOXSRZ7V4O43IANSB355QN2RNG7WVC"

const fails = (schema: Schema.Codec<unknown, string>, input: string) =>
  expect(Schema.decodeResult(schema)(input)).toStrictEqual(
    Result.fail(expect.objectContaining({ _tag: "SchemaError" }))
  )

describe("StellarAddress", () => {
  it("should decode a valid Stellar account address", () => {
    expect(Schema.decodeSync(StellarAddress)(account)).toBe(account)
  })

  it("should decode a valid Stellar contract address", () => {
    expect(Schema.decodeSync(StellarAddress)(contractAddress)).toBe(contractAddress)
  })

  it("should upper-case the input", () => {
    expect(Schema.decodeSync(StellarAccountAddress)(account.toLowerCase())).toBe(account)
    expect(Schema.decodeSync(StellarContractAddress)(contractAddress.toLowerCase())).toBe(contractAddress)
  })

  it("should round trip through encode", () => {
    const decoded = Schema.decodeSync(StellarAddress)(contractAddress)
    expect(Schema.encodeSync(StellarAddress)(decoded)).toBe(contractAddress)
  })

  it("a stellar address should begin with G or C", () => {
    fails(StellarAddress, "DBYIQXBKEB655EB3WTRITS6RR5GXEP6SQRBLPREZHNFYKT7WBMTMPR3H")
  })

  it("a stellar address should be exactly 56 characters long", () => {
    fails(StellarAddress, "GBYIQXBKEB655EB3WTRITS6RR5GXEP6SQRBLPREZHNFYKT7WBMTMPR")
  })

  it("should reject a well-formed address with a bad checksum", () => {
    fails(StellarAddress, "GBYIQXBKEB655EB3WTRITS6RR5GXEP6SQRBLPREZHNFYKT7WBMTMPR3A")
    fails(StellarAddress, "CCAANR7HZNOXYZD7SXS2WQLV5BAOXSRZ7V4O43IANSB355QN2RNG7WVA")
  })

  it("should not mix account and contract addresses", () => {
    fails(StellarAccountAddress, contractAddress)
    fails(StellarContractAddress, account)
  })

  it("should reject muxed accounts", () => {
    fails(StellarAddress, "MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAAAAAAAACJUQ")
  })

  it("should decode the null Stellar address", () => {
    const nullAddress = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"
    expect(Schema.decodeSync(StellarAddress)(nullAddress)).toStrictEqual(NULL_STELLAR_ADDRESS)
    expect(NULL_STELLAR_ADDRESS).toBe(contract.NULL_ACCOUNT)
  })

  it.effect("should generate decodable values", () =>
    Effect.gen(function*() {
      const samples = yield* Arbitrary.sampleEffect(Arbitrary.schema(StellarAddress))
      for (const sample of samples) {
        expect(Schema.decodeSync(StellarAddress)(sample)).toBe(sample)
      }
    }))
})
