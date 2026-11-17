// Records real provider replies into `test/fixtures/<provider>/<case>.json`, replayed by `SolanaRpc.fixtures.test.ts`.
// Run: `node --env-file=<path to .env> scripts/record-fixtures.ts` (needs the network).
// Inputs are pinned so that a re-run records the same data, except the head (`slot`) which moves by nature.
import { type Case, record, secret } from "../../core/scripts/recordFixtures.ts"

const EUTBL = "6rS8E5CQHLHmLenNNevUdJ9APzKNairr1kfWAM3EhDX3"
// EUTBL mint signatures, finalized: page 1 is the 5 below BEFORE, page 2 runs from its last one down to UNTIL
const BEFORE = "4x5fSpdWHJPfbt7RWjFcqcNZ8iy31q5bfph7VgXY9oADn6q1a4zGUquoHFmJ9e6WXJ6ai5oLy54q5gyXs32mhZib"
const UNTIL = "4HUA4Hbnr6hrEckfA9rzgfibnndv4v9tTvrKQWFtCKjcv8WZ1Co5HRHQCzZrsmfSUAw6uaXJSVYczKYT3F5D5sjR"
const PAGE_1_LAST = "4xocP3Kt2QwqgiZdBrTseXvmTZsRVPh2v94NsM8Uwb5HiSUDWgrkUUZxSPpA3Mfy7sLCdMiKZ4nJcnT6EJsLU372"
const TX_1 = "2ijR446DGZ3zFMDdp5JrbonSpRwrvN4bGK7oGiLpn5DpR9eCFHZjMPh89feRiuygcVhhY6HxP64y5xtnVfKJutz1"
const TX_2 = "2X2K6U3mUT7PFkcuh3N3u5T7ZaVdYKZh9eEHjfD4U92sYLqduHddwbCDDbZhyQbZZjMPdeKCzLEiNLR2LDWZzake"
// a v0 swap loading 7 writable and 13 readonly addresses from lookup tables
const TX_V0 = "4RDVWk5s7nJUceFyi9XivKi8BYgogvhqyGv3u4HPXiAHyq8Eu6o5QFTHUqrx48vRGfurA7J4yk1cZY4Ybs4J59NF"
// a Binance hot wallet: its balance moves on every recording
const BINANCE = "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9"
// well-formed, never sent on chain
const UNKNOWN_TX = "5UfDuX7WXYZdgnWkLhKnga5PsaFdMNQdi5SBPYB4RY5UBbQDN3kQz3VEABDaGbNkYPhGMaFKaLwUMcnMnEHG77v"
// a Raydium swap failing on its slippage check (`{ InstructionError: [1, { Custom: 30 }] }`)
const FAILED_CUSTOM = "65AsgMptVkfYADN4Jv4Av1SJJAErag2FnDaYE8FJGzDAejiDyJr2JUawciHHUG5ApDX38U4w3kNW48cViH7sCWyd"
// a BINANCE transaction failing in a native program (`{ InstructionError: [0, "InvalidArgument"] }`)
const FAILED_NAMED = "57i2325snWTEZzhRwxfkePj15s5XTKZMEgNCaxzLzVWWjnP7soGfY66iPEm8QK5pkWSF4Y74eHsF6TwaB44ZUnDZ"
// unsigned v0 transfers of 1 lamport to EUTBL, never sent: from BINANCE, then from an address that holds no account
const TRANSFER =
  "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAQABA0jAG1BZAFRV2dywxrzs3LT7Wy6rwamoK1c5K6qkDwTmVvRNf1zV6IwhSfE1H6LSw93Y1mp8rd/3ORnMY9EIQE4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQICAAEMAgAAAAEAAAAAAAAAAA=="
const TRANSFER_UNFUNDED =
  "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAQABAzmZGF4hAZXnrjzCLzvpuAbmKzGFNed473dzSiOxrvGWVvRNf1zV6IwhSfE1H6LSw93Y1mp8rd/3ORnMY9EIQE4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQICAAEMAgAAAAEAAAAAAAAAAA=="
// far above the head for years
const FUTURE_SLOT = 999_999_999_999

const finalized = { commitment: "finalized" }
const base64 = { commitment: "finalized", encoding: "base64", maxSupportedTransactionVersion: 0 }
const json = { ...base64, encoding: "json" }
// the signatures are zeroes and the blockhash a placeholder: the node skips the first and replaces the second
const simulation = { encoding: "base64", ...finalized, sigVerify: false, replaceRecentBlockhash: true }

// params in the order and shape `src/internal/rpcMethods.ts` encodes them
const cases: ReadonlyArray<Case> = [
  { name: "getGenesisHash", method: "getGenesisHash", params: [] },
  { name: "getSlot", method: "getSlot", params: [finalized] },
  {
    name: "getSignaturesForAddress-page-1",
    method: "getSignaturesForAddress",
    params: [EUTBL, { before: BEFORE, until: UNTIL, limit: 5, ...finalized }]
  },
  {
    name: "getSignaturesForAddress-page-2",
    method: "getSignaturesForAddress",
    params: [EUTBL, { before: PAGE_1_LAST, until: UNTIL, limit: 5, ...finalized }]
  },
  { name: "getTransaction-eutbl-1", method: "getTransaction", params: [TX_1, base64] },
  { name: "getTransaction-eutbl-2", method: "getTransaction", params: [TX_2, base64] },
  { name: "getTransaction-eutbl-1-json", method: "getTransaction", params: [TX_1, json] },
  { name: "getTransaction-eutbl-2-json", method: "getTransaction", params: [TX_2, json] },
  { name: "getTransaction-v0", method: "getTransaction", params: [TX_V0, base64] },
  { name: "getTransaction-v0-json", method: "getTransaction", params: [TX_V0, json] },
  { name: "getBalance", method: "getBalance", params: [BINANCE, finalized] },
  { name: "getTransaction-unknown", method: "getTransaction", params: [UNKNOWN_TX, base64] },
  {
    name: "getSignaturesForAddress-min-context-slot",
    method: "getSignaturesForAddress",
    // Alchemy ignores `minContextSlot` here and answers: pinned like page 1 so that the reply stays the same
    params: [EUTBL, { before: BEFORE, until: UNTIL, limit: 5, ...finalized, minContextSlot: FUTURE_SLOT }]
  },
  { name: "getBlockHeight", method: "getBlockHeight", params: [finalized] },
  { name: "getEpochInfo", method: "getEpochInfo", params: [finalized] },
  {
    name: "getSignatureStatuses",
    method: "getSignatureStatuses",
    params: [[TX_1, FAILED_CUSTOM, FAILED_NAMED, UNKNOWN_TX], { searchTransactionHistory: true }]
  },
  // without the history, a transaction older than the node's status cache is unknown
  {
    name: "getSignatureStatuses-recent",
    method: "getSignatureStatuses",
    params: [[TX_1], { searchTransactionHistory: false }]
  },
  { name: "getLatestBlockhash", method: "getLatestBlockhash", params: [finalized] },
  { name: "getRecentPrioritizationFees", method: "getRecentPrioritizationFees", params: [[BINANCE]] },
  { name: "simulateTransaction", method: "simulateTransaction", params: [TRANSFER, simulation] },
  { name: "simulateTransaction-failed", method: "simulateTransaction", params: [TRANSFER_UNFUNDED, simulation] },
  // Alchemy accepts a `limit` from 1 to 10000
  { name: "invalid-params", method: "getSignaturesForAddress", params: [EUTBL, { limit: 0, ...finalized }] },
  { name: "invalid-key", method: "getGenesisHash", params: [], invalidKey: true }
]

await record({
  network: "Solana",
  fixtures: new URL("../test/fixtures/", import.meta.url),
  providers: [
    { name: "alchemy", url: (key) => `https://solana-mainnet.g.alchemy.com/v2/${key}`, key: secret("ALCHEMY_API_KEY") }
  ],
  cases
})
