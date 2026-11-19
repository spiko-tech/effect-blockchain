// Records real Ethereum mainnet replies from Alchemy and Infura into `test/fixtures/<provider>/<case>.json`, replayed by
// `test/EvmRpc.fixtures.test.ts`. Needs the network and the keys in the environment:
//   node --env-file=<path to .env> scripts/record-fixtures.ts
// Inputs are pinned, so a re-run records the same replies (except `blockNumber`, `getTransactionCount` and `feeHistory`,
// read at the moving head). Never edit a reply. `eth_sendRawTransaction` is never recorded: nothing is sent to mainnet.
import { type Case, type Json, record, secret } from "../../core/scripts/recordFixtures.ts"

// two tokenized fund tokens, lowercased as `EvmAddress` encodes them
const TOKENS = ["0xa0769f7a8fc65e47de93797b4e21c073c117fc80", "0xe4880249745eac5f1ed9d8f7df844792d560e750"]
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
// blocks 26083549..26083558: 4 USTBL and 1 EUTBL Transfer logs, within Alchemy's free-tier 10-block range
const FROM = 26083549
const TO = 26083558
// the Ethereum Foundation's wallet, lowercased as `EvmAddress` encodes it
const FOUNDATION = "0xde0b295669a9fd93d5f28d9ec85e40f4cb697bae"
// in block FROM: the transaction of the first `getLogs` log, and one that reverted
const TRANSACTION = "0x5b742dac0f3747de0d0196a04c4d821c8e086f06c4b98d024b08ae18ea39678e"
const REVERTED = "0x94bb947f04a680590b0c639820e7c7552521a26b2fa424824984be66e5bcc39c"
const UNKNOWN = `0x${"0".repeat(63)}1`
const BURN = "0x000000000000000000000000000000000000dead"
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
// `transfer(BURN, 2^255)`: more than any balance
const OVERDRAWN = `0xa9059cbb${BURN.slice(2).padStart(64, "0")}8${"0".repeat(63)}`
const DECIMALS = "0x313ce567"

const hex = (n: number) => `0x${n.toString(16)}`
const logsFilter = (fromBlock: string, toBlock: string, topics: Json = [TRANSFER]) => [
  { address: TOKENS, fromBlock, toBlock, topics }
]

const cases: ReadonlyArray<Case> = [
  { name: "chainId", method: "eth_chainId", params: [] },
  { name: "blockNumber", method: "eth_blockNumber", params: [] },
  { name: "getLogs", method: "eth_getLogs", params: logsFilter(hex(FROM), hex(TO)) },
  // the block of the first `getLogs` log, transaction hashes only
  { name: "getBlockByNumber", method: "eth_getBlockByNumber", params: [hex(FROM), false] },
  // state older than the last 128 blocks: only an archive node answers it
  { name: "getBalance", method: "eth_getBalance", params: [FOUNDATION, hex(FROM)] },
  // 10010 blocks: above Alchemy's free tier (10) and Infura's (10000) limits
  { name: "getLogs-range-too-large", method: "eth_getLogs", params: logsFilter(hex(TO - 10009), hex(TO)) },
  { name: "getLogs-beyond-head", method: "eth_getLogs", params: logsFilter("0xfffffff6", "0xffffffff") },
  // a 1-byte topic, which the library encodes as given
  { name: "invalid-params", method: "eth_getLogs", params: logsFilter(hex(FROM), hex(TO), [["0xab"]]) },
  { name: "invalid-key", method: "eth_chainId", params: [], invalidKey: true },
  { name: "getTransactionByHash", method: "eth_getTransactionByHash", params: [TRANSACTION] },
  { name: "getTransactionByHash-unknown", method: "eth_getTransactionByHash", params: [UNKNOWN] },
  { name: "getTransactionReceipt", method: "eth_getTransactionReceipt", params: [TRANSACTION] },
  { name: "getTransactionReceipt-reverted", method: "eth_getTransactionReceipt", params: [REVERTED] },
  { name: "getTransactionReceipt-unknown", method: "eth_getTransactionReceipt", params: [UNKNOWN] },
  // a contract: its nonce only counts the contracts it created
  { name: "getTransactionCount", method: "eth_getTransactionCount", params: [FOUNDATION, "pending"] },
  // 1 wei to an address without code: the 21000 gas of a plain transfer
  { name: "estimateGas", method: "eth_estimateGas", params: [{ from: FOUNDATION, to: BURN, value: "0x1" }] },
  { name: "estimateGas-reverted", method: "eth_estimateGas", params: [{ from: BURN, to: USDC, data: OVERDRAWN }] },
  // USDC `decimals()`: 6, the same at any block
  { name: "call", method: "eth_call", params: [{ to: USDC, data: DECIMALS }, "latest"] },
  { name: "call-reverted", method: "eth_call", params: [{ from: BURN, to: USDC, data: OVERDRAWN }, "latest"] },
  { name: "feeHistory", method: "eth_feeHistory", params: ["0x4", "latest", [25, 75]] }
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
