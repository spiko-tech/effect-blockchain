// Records real Ethereum mainnet replies from Alchemy and Infura into `test/fixtures/<provider>/<case>.json`, replayed by
// `test/EvmRpc.fixtures.test.ts`. Needs the network and the keys in the environment:
//   node --env-file=<path to .env> scripts/record-fixtures.ts
// Inputs are pinned, so a re-run records the same replies (except `blockNumber`, the moving head). Never edit a reply.
import { type Case, type Json, record, secret } from "../../core/scripts/recordFixtures.ts"

// Spiko EUTBL and USTBL (docs.spiko.io/documentation/tokenization/addresses), lowercased as `EvmAddress` encodes them
const SPIKO_TOKENS = ["0xa0769f7a8fc65e47de93797b4e21c073c117fc80", "0xe4880249745eac5f1ed9d8f7df844792d560e750"]
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
// blocks 26083549..26083558: 4 USTBL and 1 EUTBL Transfer logs, within Alchemy's free-tier 10-block range
const FROM = 26083549
const TO = 26083558

const hex = (n: number) => `0x${n.toString(16)}`
const logsFilter = (fromBlock: string, toBlock: string, topics: Json = [TRANSFER]) => [
  { address: SPIKO_TOKENS, fromBlock, toBlock, topics }
]

const cases: ReadonlyArray<Case> = [
  { name: "chainId", method: "eth_chainId", params: [] },
  { name: "blockNumber", method: "eth_blockNumber", params: [] },
  { name: "getLogs", method: "eth_getLogs", params: logsFilter(hex(FROM), hex(TO)) },
  // the block of the first `getLogs` log, transaction hashes only
  { name: "getBlockByNumber", method: "eth_getBlockByNumber", params: [hex(FROM), false] },
  // 10010 blocks: above Alchemy's free tier (10) and Infura's (10000) limits
  { name: "getLogs-range-too-large", method: "eth_getLogs", params: logsFilter(hex(TO - 10009), hex(TO)) },
  { name: "getLogs-beyond-head", method: "eth_getLogs", params: logsFilter("0xfffffff6", "0xffffffff") },
  // a 1-byte topic, which the library encodes as given
  { name: "invalid-params", method: "eth_getLogs", params: logsFilter(hex(FROM), hex(TO), [["0xab"]]) },
  { name: "invalid-key", method: "eth_chainId", params: [], invalidKey: true }
]

await record({
  network: "Ethereum",
  fixtures: new URL("../test/fixtures/", import.meta.url),
  providers: [
    { name: "alchemy", url: (key) => `https://eth-mainnet.g.alchemy.com/v2/${key}`, key: secret("ALCHEMY_API_KEY") },
    { name: "infura", url: (key) => `https://mainnet.infura.io/v3/${key}`, key: secret("INFURA_TOKEN") }
  ],
  cases
})
