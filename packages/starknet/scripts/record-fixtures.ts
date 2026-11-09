// Records real Starknet mainnet provider replies into `test/fixtures/<provider>/<case>.json`, replayed by
// `test/StarknetRpc.fixtures.test.ts`. Needs the network and the keys, never written to the fixtures:
//
//   node --env-file=<path to .env> scripts/record-fixtures.ts
//
// Inputs are pinned (past block range, transaction hash) so a re-run records the same replies, except the head.
// Bodies are the same as the ones `src/internal/rpcMethods.ts` encodes.
import { type Case, type Json, record, secret } from "../../core/scripts/recordFixtures.ts"

// a tokenized fund token on Starknet, blocks 1380300..1380400 hold 12 Transfer events in 3 transactions
const EUTBL = "0x04f5e0de717daa6aa8de63b1bf2e8d7823ec5b21a88461b1519d9dbc956fb7f2"
// the STRK token and the mainnet staking contract, which holds STRK: https://docs.starknet.io/resources/chain-info
const STRK_TOKEN_ADDRESS = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d"
const STAKING = "0x00ca1702e64c81d9a07b86bd2c540188d92a2c73cf5cc0e508d949015e7e84a7"
// sn_keccak("balanceOf")
const BALANCE_OF = "0x02e4263afad30923c891518314c3c95dbe830a16874e8abc5777a9a20b54c76e"
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
  {
    name: "call-balanceOf",
    method: "starknet_call",
    params: {
      request: { contract_address: STRK_TOKEN_ADDRESS, entry_point_selector: BALANCE_OF, calldata: [STAKING] },
      block_id: { block_number: 1380308 }
    }
  },
  {
    name: "call-contract-not-found",
    method: "starknet_call",
    params: {
      request: {
        contract_address: "0x0000000000000000000000000000000000000000000000000000000000000001",
        entry_point_selector: BALANCE_OF,
        calldata: [STAKING]
      },
      block_id: { block_number: 1380308 }
    }
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
