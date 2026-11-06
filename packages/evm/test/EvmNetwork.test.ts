import {
  defaultConfirmations,
  EvmChainId,
  EvmNetwork,
  fromChainId,
  isTestnet,
  mainnets,
  networks,
  testnets,
  toChainId
} from "@effect-blockchain/evm/EvmNetwork"
import { describe, expect, it } from "@effect/vitest"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as chains from "viem/chains"

const viemChains: Record<EvmNetwork, chains.Chain> = {
  Ethereum: chains.mainnet,
  Sepolia: chains.sepolia,
  Polygon: chains.polygon,
  PolygonAmoy: chains.polygonAmoy,
  Base: chains.base,
  BaseSepolia: chains.baseSepolia,
  Arbitrum: chains.arbitrum,
  ArbitrumSepolia: chains.arbitrumSepolia,
  Etherlink: chains.etherlink,
  EtherlinkTestnet: chains.etherlinkTestnet,
  Optimism: chains.optimism,
  OptimismSepolia: chains.optimismSepolia,
  Avalanche: chains.avalanche,
  AvalancheFuji: chains.avalancheFuji,
  BnbSmartChain: chains.bsc,
  BnbSmartChainTestnet: chains.bscTestnet,
  Gnosis: chains.gnosis,
  Linea: chains.linea,
  LineaSepolia: chains.lineaSepolia,
  // viem leaves foundry untagged, a local dev node is a testnet here
  Anvil: { ...chains.foundry, testnet: true }
}

describe("EvmNetwork", () => {
  it("chain IDs and testnet tags match viem/chains", () => {
    for (const network of networks) {
      const chain = viemChains[network]
      expect(toChainId(network), network).toBe(chain.id)
      expect(isTestnet(network), network).toBe(chain.testnet === true)
    }
  })

  it("fromChainId inverts toChainId", () => {
    for (const network of networks) {
      expect(fromChainId(toChainId(network))).toStrictEqual(Option.some(network))
    }
    expect(fromChainId(1337)).toStrictEqual(Option.none())
  })

  it("Anvil is the local Foundry node on chain 31337 with no confirmations", () => {
    expect(toChainId("Anvil")).toBe(31337)
    expect(fromChainId(31337)).toStrictEqual(Option.some("Anvil"))
    expect(defaultConfirmations("Anvil")).toBe(0)
  })

  it("chain IDs are unique and mainnets/testnets partition networks", () => {
    expect(new Set(networks.map(toChainId)).size).toBe(networks.length)
    expect(networks.length).toBe(mainnets.length + testnets.length)
  })

  it("decodes known networks and rejects others", () => {
    expect(Schema.decodeUnknownSync(EvmNetwork)("Base")).toBe("Base")
    expect(Result.isFailure(Schema.decodeUnknownResult(EvmNetwork)("ArbitrumUk"))).toBe(true)
  })
})

describe("EvmChainId", () => {
  it("accepts positive integers and rejects the rest", () => {
    expect(Schema.decodeUnknownSync(EvmChainId)(1)).toBe(1)
    for (const input of [0, -1, 1.5, "1"]) {
      expect(Result.isFailure(Schema.decodeUnknownResult(EvmChainId)(input))).toBe(true)
    }
  })
})
