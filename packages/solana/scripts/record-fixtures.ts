// Records real provider replies into `test/fixtures/<provider>/<case>.json`, replayed by `SolanaRpc.fixtures.test.ts`.
// Run: `node --env-file=$HOME/spiko/loop-crypto/.env scripts/record-fixtures.ts` (needs the network).
// Inputs are pinned so that a re-run records the same data, except the head (`slot`) which moves by nature.
import { type Case, record, secret } from "../../core/scripts/recordFixtures.ts"

const EUTBL = "6rS8E5CQHLHmLenNNevUdJ9APzKNairr1kfWAM3EhDX3"
// EUTBL mint signatures, finalized: page 1 is the 5 below BEFORE, page 2 runs from its last one down to UNTIL
const BEFORE = "4x5fSpdWHJPfbt7RWjFcqcNZ8iy31q5bfph7VgXY9oADn6q1a4zGUquoHFmJ9e6WXJ6ai5oLy54q5gyXs32mhZib"
const UNTIL = "4HUA4Hbnr6hrEckfA9rzgfibnndv4v9tTvrKQWFtCKjcv8WZ1Co5HRHQCzZrsmfSUAw6uaXJSVYczKYT3F5D5sjR"
const PAGE_1_LAST = "4xocP3Kt2QwqgiZdBrTseXvmTZsRVPh2v94NsM8Uwb5HiSUDWgrkUUZxSPpA3Mfy7sLCdMiKZ4nJcnT6EJsLU372"
const TX_1 = "2ijR446DGZ3zFMDdp5JrbonSpRwrvN4bGK7oGiLpn5DpR9eCFHZjMPh89feRiuygcVhhY6HxP64y5xtnVfKJutz1"
const TX_2 = "2X2K6U3mUT7PFkcuh3N3u5T7ZaVdYKZh9eEHjfD4U92sYLqduHddwbCDDbZhyQbZZjMPdeKCzLEiNLR2LDWZzake"
// well-formed, never sent on chain
const UNKNOWN_TX = "5UfDuX7WXYZdgnWkLhKnga5PsaFdMNQdi5SBPYB4RY5UBbQDN3kQz3VEABDaGbNkYPhGMaFKaLwUMcnMnEHG77v"
// far above the head for years
const FUTURE_SLOT = 999_999_999_999

const finalized = { commitment: "finalized" }
const base64 = { commitment: "finalized", encoding: "base64", maxSupportedTransactionVersion: 0 }
const json = { ...base64, encoding: "json" }

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
  { name: "getTransaction-unknown", method: "getTransaction", params: [UNKNOWN_TX, base64] },
  {
    name: "getSignaturesForAddress-min-context-slot",
    method: "getSignaturesForAddress",
    // Alchemy ignores `minContextSlot` here and answers: pinned like page 1 so that the reply stays the same
    params: [EUTBL, { before: BEFORE, until: UNTIL, limit: 5, ...finalized, minContextSlot: FUTURE_SLOT }]
  },
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
