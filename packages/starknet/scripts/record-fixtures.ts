// Records real Starknet mainnet provider replies into `test/fixtures/<provider>/<case>.json`, replayed by
// `test/StarknetRpc.fixtures.test.ts`. Needs the network and the keys, never written to the fixtures:
//
//   node --env-file=$HOME/spiko/loop-crypto/.env scripts/record-fixtures.ts
//
// Inputs are pinned (past block range, transaction hash) so a re-run records the same replies, except the head.
// Bodies are the same as the ones `src/internal/rpcMethods.ts` encodes.
import { type Case, type Json, record, secret } from "../../core/scripts/recordFixtures.ts"

// Spiko EUTBL on Starknet, blocks 1380300..1380400 hold 12 Transfer events in 3 transactions
const EUTBL = "0x04f5e0de717daa6aa8de63b1bf2e8d7823ec5b21a88461b1519d9dbc956fb7f2"
const RECEIPT_TX = "0x02aa671ff923b87808ec822766994ed10fd5720d7441798a96fbd770c0b7e9ab"

const events = (filter: { readonly [key: string]: Json }): Json => ({
  filter: {
    address: EUTBL,
    from_block: { block_number: 1380300 },
    to_block: { block_number: 1380400 },
    chunk_size: 5,
    ...filter
  }
})

const continuationToken = (body: string | undefined): string => {
  const token = body === undefined ? undefined : JSON.parse(body).result?.continuation_token
  if (typeof token !== "string") throw new Error("getEvents-page-1 returned no continuation_token")
  return token
}

const cases: ReadonlyArray<Case> = [
  { name: "chainId", method: "starknet_chainId", params: {} },
  { name: "blockNumber", method: "starknet_blockNumber", params: {} },
  { name: "getEvents-page-1", method: "starknet_getEvents", params: events({}) },
  {
    name: "getEvents-page-2",
    method: "starknet_getEvents",
    params: (recorded) => events({ continuation_token: continuationToken(recorded.get("getEvents-page-1")) })
  },
  {
    name: "getTransactionReceipt",
    method: "starknet_getTransactionReceipt",
    params: { transaction_hash: RECEIPT_TX }
  },
  {
    name: "getBlockWithTxHashes",
    method: "starknet_getBlockWithTxHashes",
    params: { block_id: { block_number: 1380308 } }
  },
  {
    name: "getEvents-beyond-head",
    method: "starknet_getEvents",
    params: events({ to_block: { block_number: 99999999 } })
  },
  { name: "getEvents-chunk-too-big", method: "starknet_getEvents", params: events({ chunk_size: 10000 }) },
  {
    name: "getEvents-invalid-token",
    method: "starknet_getEvents",
    params: events({ continuation_token: "invalid" })
  },
  { name: "invalid-key", method: "starknet_chainId", params: {}, invalidKey: true }
]

await record({
  network: "Starknet",
  fixtures: new URL("../test/fixtures/", import.meta.url),
  providers: [
    {
      name: "alchemy",
      url: (key) => `https://starknet-mainnet.g.alchemy.com/starknet/version/rpc/v0_9/${key}`,
      key: secret("ALCHEMY_API_KEY")
    },
    { name: "infura", url: (key) => `https://starknet-mainnet.infura.io/v3/${key}`, key: secret("INFURA_TOKEN") }
  ],
  cases
})
