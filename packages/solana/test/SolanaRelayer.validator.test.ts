import { type SolanaAddress, SYSTEM_PROGRAM_ADDRESS } from "@effect-blockchain/solana/SolanaAddress"
import { SolanaGenesisHash } from "@effect-blockchain/solana/SolanaNetwork"
import * as SolanaRelayer from "@effect-blockchain/solana/SolanaRelayer"
import * as SolanaRpc from "@effect-blockchain/solana/SolanaRpc"
import * as SolanaSigner from "@effect-blockchain/solana/SolanaSigner"
import { SolanaTransactionHash } from "@effect-blockchain/solana/SolanaTransactionHash"
import { describe, expect, it } from "@effect/vitest"
import {
  createKeyPairFromPrivateKeyBytes,
  getAddressFromPublicKey,
  getBase58Decoder,
  getBase58Encoder
} from "@solana/kit"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"

// runs against a local validator (`solana-test-validator --reset`, then
// `SOLANA_TEST_VALIDATOR_RPC_URL=http://127.0.0.1:8899 pnpm vitest run`), skipped otherwise
const url = process.env.SOLANA_TEST_VALIDATOR_RPC_URL ?? ""

const SOL = BigInt(1_000_000_000)
const Reply = Schema.Struct({ result: Schema.String })

// the calls outside `SolanaRpc`: the validator's own `requestAirdrop`, and its genesis hash before the layer exists
const call = (method: string, params: ReadonlyArray<Schema.Json>) =>
  Effect.promise(() =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
    }).then((response) => response.json())
  ).pipe(Effect.map((reply) => Schema.decodeUnknownSync(Reply)(reply).result))

// a ledger made by `solana-test-validator` has its own genesis hash
const layer = Layer.unwrap(Effect.map(call("getGenesisHash", []), (genesisHash) =>
  SolanaRelayer.layer().pipe(
    Layer.provideMerge(SolanaRpc.layer({
      network: "SolanaDevnet",
      genesisHash: Schema.decodeSync(SolanaGenesisHash)(genesisHash),
      endpoints: [{ name: "validator", url: Redacted.make(url) }]
    })),
    Layer.provide(FetchHttpClient.layer)
  )))

const poll = Schedule.spaced("200 millis")

// a key made for the test, known to this validator only
const generate = Effect.promise(async () => {
  const privateKey = crypto.getRandomValues(new Uint8Array(32))
  const keyPair = await createKeyPairFromPrivateKeyBytes(privateKey)
  const publicKey = getBase58Encoder().encode(await getAddressFromPublicKey(keyPair.publicKey))
  return getBase58Decoder().decode(Uint8Array.from([...privateKey, ...publicKey]))
}).pipe(Effect.flatMap((secret) => SolanaSigner.fromPrivateKey(Redacted.make(secret))))

// the blockhash, the fees and the preflight are read at `confirmed`: the airdrop is waited for at that commitment
const funded = Effect.gen(function*() {
  const rpc = yield* SolanaRpc.SolanaRpc
  const signer = yield* generate
  const airdrop = SolanaTransactionHash.make(yield* call("requestAirdrop", [signer.address, Number(SOL)]))
  // Agave refuses a config without `searchTransactionHistory`
  yield* rpc.getSignatureStatuses({ signatures: [airdrop], searchTransactionHistory: false }).pipe(
    Effect.repeat({
      schedule: poll,
      until: ({ value }) => value[0] !== null && value[0]?.confirmationStatus !== "processed"
    })
  )
  return signer
})

const transfer = (from: SolanaAddress, to: SolanaAddress, lamports: bigint): SolanaRelayer.SolanaInstruction => {
  // the System program's `Transfer`: discriminator 2 (u32), then the lamports (u64), little-endian
  const data = new DataView(new ArrayBuffer(12))
  data.setUint32(0, 2, true)
  data.setBigUint64(4, lamports, true)
  return {
    programAddress: SYSTEM_PROGRAM_ADDRESS,
    accounts: [{ address: from, signer: true, writable: true }, { address: to, writable: true }],
    data: new Uint8Array(data.buffer)
  }
}

describe.skipIf(url === "")("SolanaRelayer on solana-test-validator", { timeout: 120_000 }, () => {
  it.live("signs, broadcasts and confirms a transfer, then one with a second signer", () =>
    Effect.gen(function*() {
      const relayer = yield* SolanaRelayer.SolanaRelayer
      const rpc = yield* SolanaRpc.SolanaRpc
      const payer = yield* funded
      const other = yield* generate
      const sent = yield* relayer.sign({
        feePayer: payer,
        instructions: [transfer(payer.address, other.address, SOL / BigInt(10))]
      })
      expect(yield* relayer.fetchTransactionStatus(sent)).toStrictEqual({ _tag: "NotFound" })
      expect(yield* relayer.broadcast(sent)).toBe(sent.hash)
      const status = yield* relayer.awaitConfirmation({ ...sent, poll })
      const { slot } = yield* rpc.getTransaction({ signature: sent.hash, commitment: "finalized" })
      expect(status).toStrictEqual({ _tag: "Confirmed", block: slot })
      // the transaction is in a block: the validator answers `AlreadyProcessed` to its second copy
      expect(yield* relayer.broadcast(sent)).toBe(sent.hash)

      const back = yield* relayer.sign({
        feePayer: payer,
        signers: [other],
        instructions: [transfer(other.address, payer.address, SOL / BigInt(20))]
      })
      yield* relayer.broadcast(back)
      expect(yield* relayer.awaitConfirmation({ ...back, poll })).toMatchObject({ _tag: "Confirmed" })
      expect((yield* rpc.getBalance({ address: other.address })).value).toBe(SOL / BigInt(20))
    }).pipe(Effect.provide(layer)))

  it.live("reports a failing instruction as Failed", () =>
    Effect.gen(function*() {
      const relayer = yield* SolanaRelayer.SolanaRelayer
      const rpc = yield* SolanaRpc.SolanaRpc
      const payer = yield* funded
      // more than the payer holds: the System program fails with its `ResultWithNegativeLamports` (1)
      const instructions = [transfer(payer.address, (yield* generate).address, SOL * BigInt(10))]
      const error = { InstructionError: [2, { Custom: 1 }] }
      const estimated = yield* Effect.flip(relayer.sign({ feePayer: payer, instructions }))
      expect(estimated).toMatchObject({ _tag: "SimulationFailed", error })
      const sent = yield* relayer.sign({
        feePayer: payer,
        instructions,
        computeUnitLimit: 10_000,
        computeUnitPrice: BigInt(1)
      })
      const refused = yield* Effect.flip(relayer.broadcast(sent))
      expect(refused).toMatchObject({ _tag: "SolanaBroadcastError", reason: { _tag: "SimulationFailed", error } })
      // without the preflight, the transaction lands and pays its fee
      yield* rpc.sendTransaction({ transaction: sent.signed, skipPreflight: true })
      const status = yield* relayer.awaitConfirmation({ ...sent, poll })
      expect(status).toMatchObject({ _tag: "Failed", reason: error })
    }).pipe(Effect.provide(layer)))

  it.live("refuses an unfunded fee payer and an unknown blockhash, which ends Expired", () =>
    Effect.gen(function*() {
      const relayer = yield* SolanaRelayer.SolanaRelayer
      const payer = yield* funded
      const poor = yield* generate
      const budget = { computeUnitLimit: 10_000, computeUnitPrice: BigInt(1) }
      const unfunded = yield* relayer.sign({
        feePayer: poor,
        instructions: [transfer(poor.address, payer.address, BigInt(1))],
        ...budget
      })
      expect(yield* Effect.flip(relayer.broadcast(unfunded))).toMatchObject({
        _tag: "SolanaBroadcastError",
        reason: { _tag: "InsufficientFundsForFee" }
      })

      const stale = yield* relayer.sign({
        feePayer: payer,
        instructions: [transfer(payer.address, poor.address, SOL / BigInt(10))],
        // a hash no block ever had, so that the test does not wait 150 blocks for a real one to expire
        blockhash: { blockhash: SYSTEM_PROGRAM_ADDRESS, lastValidBlockHeight: BigInt(0) },
        ...budget
      })
      expect(yield* Effect.flip(relayer.broadcast(stale))).toMatchObject({
        _tag: "SolanaBroadcastError",
        reason: { _tag: "BlockhashNotFound" }
      })
      expect(yield* relayer.awaitConfirmation({ ...stale, poll })).toStrictEqual({ _tag: "Expired" })
    }).pipe(Effect.provide(layer)))
})
