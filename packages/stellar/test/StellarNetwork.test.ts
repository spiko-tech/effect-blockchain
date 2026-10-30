import {
  isTestnet,
  mainnets,
  networks,
  StellarNetwork,
  testnets,
  toPassphrase
} from "@effect-blockchain/stellar/StellarNetwork"
import { describe, expect, it } from "@effect/vitest"
import { Networks } from "@stellar/stellar-sdk"
import * as Schema from "effect/Schema"

describe("StellarNetwork", () => {
  it("should decode the known networks", () => {
    expect(Schema.decodeSync(StellarNetwork)("Stellar")).toBe("Stellar")
    expect(Schema.decodeSync(StellarNetwork)("StellarTestnet")).toBe("StellarTestnet")
  })

  it("should reject unknown networks", () => {
    expect(Schema.is(StellarNetwork)("StellarFuturenet")).toBe(false)
  })

  it("should match the stellar-sdk passphrases", () => {
    expect(networks.map(toPassphrase)).toStrictEqual([Networks.PUBLIC, Networks.TESTNET])
  })

  it("should tag testnets", () => {
    expect(networks.map(isTestnet)).toStrictEqual([false, true])
    expect(networks.length).toBe(mainnets.length + testnets.length)
  })
})
