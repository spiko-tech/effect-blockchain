import * as JsonRpc from "@effect-blockchain/core/JsonRpc"
import { SolanaAddress, SYSTEM_PROGRAM_ADDRESS } from "@effect-blockchain/solana/SolanaAddress"
import * as SolanaRelayer from "@effect-blockchain/solana/SolanaRelayer"
import * as SolanaRpc from "@effect-blockchain/solana/SolanaRpc"
import * as SolanaSigner from "@effect-blockchain/solana/SolanaSigner"
import { SolanaTransactionHash } from "@effect-blockchain/solana/SolanaTransactionHash"
import { describe, expect, it } from "@effect/vitest"
import {
  createKeyPairFromPrivateKeyBytes,
  getAddressFromPublicKey,
  getBase58Decoder,
  getBase58Encoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  signBytes
} from "@solana/kit"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"

const BLOCKHASH = "fg5jAcb27Hok8kTbs8bzgACf8SyfWF51NGoPabTJAPm"
const TO = SolanaAddress.make("6rS8E5CQHLHmLenNNevUdJ9APzKNairr1kfWAM3EhDX3")
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111"
const HASH = SolanaTransactionHash.make(
  "2ijR446DGZ3zFMDdp5JrbonSpRwrvN4bGK7oGiLpn5DpR9eCFHZjMPh89feRiuygcVhhY6HxP64y5xtnVfKJutz1"
)

// a signer made from `seed`, with the key pair `@solana/kit` checks its signatures against
const signerOf = (seed: number) =>
  Effect.gen(function*() {
    const privateKey = new Uint8Array(32).fill(seed)
    const keyPair = yield* Effect.promise(() => createKeyPairFromPrivateKeyBytes(privateKey))
    const publicKey = getBase58Encoder().encode(yield* Effect.promise(() => getAddressFromPublicKey(keyPair.publicKey)))
    const secret = getBase58Decoder().decode(Uint8Array.from([...privateKey, ...publicKey]))
    return { keyPair, signer: yield* SolanaSigner.fromPrivateKey({ key: Redacted.make(secret) }) }
  })

const transfer = (from: SolanaAddress, to: SolanaAddress): SolanaRelayer.SolanaInstruction => ({
  programAddress: SYSTEM_PROGRAM_ADDRESS,
  accounts: [{ address: from, signer: true, writable: true }, { address: to, writable: true }, { address: TO }],
  data: Uint8Array.from([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0])
})

const decode = (signed: string) => {
  const { messageBytes, signatures } = getTransactionDecoder().decode(getBase64Encoder().encode(signed))
  const message = getCompiledTransactionMessageDecoder().decode(messageBytes)
  if (message.version !== 0) throw new Error("expected a v0 message")
  return {
    messageBytes,
    signatures: Object.entries(signatures),
    blockhash: message.lifetimeToken,
    instructions: message.instructions.map((instruction) => ({
      program: message.staticAccounts[instruction.programAddressIndex],
      data: [...(instruction.data ?? [])]
    }))
  }
}

const u32 = (value: number) => [...new Uint8Array(Uint32Array.of(value).buffer)]
const u64 = (value: bigint) => [...new Uint8Array(BigUint64Array.of(value).buffer)]

const refusal = (code: number) =>
  new SolanaRpc.SolanaRpcError({
    reason: new JsonRpc.Rejected(),
    method: "sendTransaction",
    endpoint: "a",
    code,
    cause: new Error("Transaction simulation failed")
  })
const preflight = refusal(-32002)

interface Node {
  readonly fees?: ReadonlyArray<number>
  readonly simulation?: Partial<SolanaRpc.SolanaSimulation>
  readonly send?: Effect.Effect<SolanaTransactionHash, SolanaRpc.SolanaRpcError>
}

// a fake service recording the options of each call
const setup = (node: Node = {}, options?: Parameters<typeof SolanaRelayer.layer>[0]) => {
  const state: { calls: ReadonlyArray<readonly [string, object]> } = { calls: [] }
  const call = <A, E>(name: string, params: object, answer: Effect.Effect<A, E>) =>
    Effect.suspend(() => {
      state.calls = [...state.calls, [name, params]]
      return answer
    })
  const rpc = Layer.succeed(
    SolanaRpc.SolanaRpc,
    SolanaRpc.SolanaRpc.of({
      network: "Solana",
      getGenesisHash: Effect.die("unused"),
      getSlot: () => Effect.die("unused"),
      getBlockHeight: () => Effect.die("unused"),
      getEpochInfo: () => Effect.die("unused"),
      getBlockTime: () => Effect.die("unused"),
      getBlocksWithLimit: () => Effect.die("unused"),
      getTokenAccountsByOwner: () => Effect.die("unused"),
      getAccountInfo: () => Effect.die("unused"),
      getSignatureStatuses: () => Effect.die("unused"),
      getBalance: () => Effect.die("unused"),
      getSignaturesForAddress: () => Effect.die("unused"),
      getTransaction: () => Effect.die("unused"),
      getLatestBlockhash: (params) =>
        call(
          "getLatestBlockhash",
          params,
          Effect.succeed({ slot: BigInt(7), blockhash: BLOCKHASH, lastValidBlockHeight: BigInt(900) })
        ),
      getRecentPrioritizationFees: (params) =>
        call(
          "getRecentPrioritizationFees",
          params,
          Effect.succeed((node.fees ?? []).map((fee, slot) => ({
            slot: BigInt(slot),
            prioritizationFee: BigInt(fee)
          })))
        ),
      simulateTransaction: (params) =>
        call(
          "simulateTransaction",
          params,
          Effect.succeed({ slot: BigInt(7), err: null, logs: null, unitsConsumed: BigInt(1000), ...node.simulation })
        ),
      sendTransaction: (params) => call("sendTransaction", params, node.send ?? Effect.succeed(HASH))
    })
  )
  const run = <A, E>(f: (relayer: SolanaRelayer.SolanaRelayer["Service"]) => Effect.Effect<A, E>) =>
    Effect.gen(function*() {
      return yield* f(yield* SolanaRelayer.SolanaRelayer)
    }).pipe(Effect.provide(SolanaRelayer.layer(options).pipe(Layer.provide(rpc))))
  return { state, run, rpc }
}

const explicit = {
  blockhash: { blockhash: BLOCKHASH, lastValidBlockHeight: BigInt(42) },
  computeUnitLimit: 5000,
  fees: { computeUnitPrice: BigInt(7) }
}

describe("SolanaRelayer sign and broadcast", () => {
  it("defaultFees takes the 75th percentile, at least 1 micro-lamport", () => {
    const fees = (values: ReadonlyArray<number>) =>
      SolanaRelayer.defaultFees({
        prioritizationFees: values.map((fee, slot) => ({ slot: BigInt(slot), prioritizationFee: BigInt(fee) }))
      }).computeUnitPrice
    expect(fees([40, 0, 30, 0, 20, 0, 10, 5])).toBe(BigInt(30))
    expect(fees([0, 0, 0, 500])).toBe(BigInt(500))
    expect(fees([0, 0, 0, 0])).toBe(BigInt(1))
    expect(fees([])).toBe(BigInt(1))
  })

  it.effect("signs with the node's blockhash, the fee strategy and the simulated units", () => {
    const { run, state } = setup({ fees: [0, 100, 200, 300] })
    return run((relayer) =>
      Effect.gen(function*() {
        const { keyPair, signer } = yield* signerOf(1)
        const sent = yield* relayer.sign({ signer, instructions: [transfer(signer.address, TO)] })
        const { blockhash, instructions, messageBytes, signatures } = decode(sent.signed)
        expect(sent.lastValidBlockHeight).toBe(BigInt(900))
        expect(blockhash).toBe(BLOCKHASH)
        expect(instructions).toStrictEqual([
          { program: COMPUTE_BUDGET, data: [2, ...u32(1200)] },
          { program: COMPUTE_BUDGET, data: [3, ...u64(BigInt(300))] },
          { program: SYSTEM_PROGRAM_ADDRESS, data: [2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0] }
        ])
        const signature = yield* Effect.promise(() => signBytes(keyPair.privateKey, messageBytes))
        expect(signatures).toStrictEqual([[signer.address, signature]])
        expect(sent.hash).toBe(getBase58Decoder().decode(signature))

        expect(state.calls.map(([name]) => name).sort()).toStrictEqual([
          "getLatestBlockhash",
          "getRecentPrioritizationFees",
          "simulateTransaction"
        ])
        const params = Object.fromEntries(state.calls)
        expect(params.getLatestBlockhash).toStrictEqual({ commitment: "confirmed" })
        // the accounts the transaction writes to, once each
        expect(params.getRecentPrioritizationFees).toStrictEqual({ addresses: [signer.address, TO] })
        expect(params.simulateTransaction).toMatchObject({
          commitment: "confirmed",
          sigVerify: false,
          replaceRecentBlockhash: true
        })
        // simulated unsigned, with the highest compute unit limit
        const simulated = decode(Object(params.simulateTransaction).transaction)
        expect(simulated.signatures).toStrictEqual([[signer.address, null]])
        expect(simulated.instructions[0]?.data).toStrictEqual([2, ...u32(1_400_000)])
      })
    )
  })

  it.effect("signs with the given blockhash and compute budget without asking the node", () => {
    const { run, state } = setup()
    return run((relayer) =>
      Effect.gen(function*() {
        const { signer } = yield* signerOf(1)
        const sent = yield* relayer.sign({
          signer,
          instructions: [transfer(signer.address, TO)],
          ...explicit
        })
        const { instructions } = decode(sent.signed)
        expect(sent.lastValidBlockHeight).toBe(BigInt(42))
        expect(instructions[0]?.data).toStrictEqual([2, ...u32(5000)])
        expect(instructions[1]?.data).toStrictEqual([3, ...u64(BigInt(7))])
        expect(state.calls).toStrictEqual([])
      })
    )
  })

  it.effect("uses the layer's fee strategy and multiplier, and caps the compute unit limit", () =>
    Effect.gen(function*() {
      const { signer } = yield* signerOf(1)
      const options = { signer, instructions: [transfer(signer.address, TO)] as const }
      const custom = setup({ fees: [5, 6] }, {
        fees: ({ prioritizationFees }) => ({ computeUnitPrice: BigInt(prioritizationFees.length * 1000) }),
        computeUnitMultiplier: 2
      })
      const { instructions } = decode((yield* custom.run((relayer) => relayer.sign(options))).signed)
      expect(instructions[0]?.data).toStrictEqual([2, ...u32(2000)])
      expect(instructions[1]?.data).toStrictEqual([3, ...u64(BigInt(2000))])

      for (const unitsConsumed of [BigInt(1_300_000), null]) {
        const capped = setup({ simulation: { unitsConsumed } })
        const sent = yield* capped.run((relayer) => relayer.sign(options))
        expect(decode(sent.signed).instructions[0]?.data).toStrictEqual([2, ...u32(1_400_000)])
      }
    }))

  it.effect("fails with a SimulationFailed reason when the simulation fails", () => {
    const error = { InstructionError: [2, { Custom: 1 }] } as const
    const { run } = setup({ simulation: { err: error, logs: ["log"] } })
    return Effect.gen(function*() {
      const { signer } = yield* signerOf(1)
      const options = { signer, instructions: [transfer(signer.address, TO)] as const }
      const failed = yield* Effect.flip(run((relayer) => relayer.sign(options)))
      expect(failed).toMatchObject({
        _tag: "SolanaSimulationError",
        reason: { _tag: "SimulationFailed", error, logs: ["log"] }
      })
      const silent = setup({ simulation: { err: "AccountNotFound" } })
      expect(yield* Effect.flip(silent.run((relayer) => relayer.sign(options)))).toMatchObject({
        _tag: "SolanaSimulationError",
        reason: { _tag: "SimulationFailed", error: "AccountNotFound", logs: [] }
      })
    })
  })

  it.effect("refuses a compute unit limit or price the Compute Budget instructions cannot hold", () =>
    Effect.gen(function*() {
      const { signer } = yield* signerOf(1)
      const options = { signer, instructions: [transfer(signer.address, TO)] as const, ...explicit }
      const { run, state } = setup()
      for (const computeUnitLimit of [-1, 1.5, 1_400_001, 2 ** 32, Number.NaN]) {
        const error = yield* Effect.flip(run((relayer) => relayer.sign({ ...options, computeUnitLimit })))
        expect(error).toMatchObject({
          _tag: "SolanaSignerError",
          cause: new Error(`computeUnitLimit ${computeUnitLimit} is not an integer from 0 to 1400000`)
        })
      }
      for (const computeUnitPrice of [BigInt(-1), BigInt(2) ** BigInt(64)]) {
        const error = yield* Effect.flip(run((relayer) => relayer.sign({ ...options, fees: { computeUnitPrice } })))
        expect(error).toMatchObject({
          _tag: "SolanaSignerError",
          cause: new Error(`computeUnitPrice ${computeUnitPrice} is not a u64`)
        })
      }
      expect(state.calls).toStrictEqual([])
      // the bounds themselves are valid
      const bounds = { computeUnitLimit: 1_400_000, fees: { computeUnitPrice: BigInt(2) ** BigInt(64) - BigInt(1) } }
      const { instructions } = decode((yield* run((relayer) => relayer.sign({ ...options, ...bounds }))).signed)
      expect(instructions[0]?.data).toStrictEqual([2, ...u32(1_400_000)])
      expect(instructions[1]?.data).toStrictEqual([3, ...u64(bounds.fees.computeUnitPrice)])
      expect(
        decode((yield* run((relayer) => relayer.sign({ ...options, computeUnitLimit: 0 }))).signed).instructions[0]
          ?.data
      )
        .toStrictEqual([2, ...u32(0)])
      // a fee strategy or a multiplier giving an invalid value fails the same way
      const strategy = setup({}, { fees: () => ({ computeUnitPrice: BigInt(-1) }) })
      const { fees: _, ...withoutFees } = options
      expect(yield* Effect.flip(strategy.run((relayer) => relayer.sign(withoutFees)))).toMatchObject({
        _tag: "SolanaSignerError"
      })
      const multiplier = setup({}, { computeUnitMultiplier: Number.NaN })
      const { computeUnitLimit: __, ...withoutLimit } = options
      expect(yield* Effect.flip(multiplier.run((relayer) => relayer.sign(withoutLimit)))).toMatchObject({
        _tag: "SolanaSignerError"
      })
    }))

  it.effect("layerConfig reads the confirmations and the multiplier from Config", () =>
    Effect.gen(function*() {
      const { signer } = yield* signerOf(1)
      const sent = yield* Effect.gen(function*() {
        const relayer = yield* SolanaRelayer.SolanaRelayer
        return yield* relayer.sign({ signer, instructions: [transfer(signer.address, TO)] })
      }).pipe(
        Effect.provide(
          SolanaRelayer.layerConfig({ computeUnitMultiplier: Config.succeed(3) }).pipe(Layer.provide(setup().rpc))
        )
      )
      expect(decode(sent.signed).instructions[0]?.data).toStrictEqual([2, ...u32(3000)])
    }))

  it.effect("collects one signature per signer account, the signer's first", () => {
    const { run } = setup()
    return run((relayer) =>
      Effect.gen(function*() {
        const payer = yield* signerOf(1)
        const owner = yield* signerOf(2)
        const instructions = [transfer(owner.signer.address, TO)] as const
        const sent = yield* relayer.sign({ signer: payer.signer, cosigners: [owner.signer], instructions, ...explicit })
        const { messageBytes, signatures } = decode(sent.signed)
        expect(signatures).toStrictEqual([
          [payer.signer.address, yield* Effect.promise(() => signBytes(payer.keyPair.privateKey, messageBytes))],
          [owner.signer.address, yield* Effect.promise(() => signBytes(owner.keyPair.privateKey, messageBytes))]
        ])
        expect(sent.hash).toBe(getBase58Decoder().decode(signatures[0]?.[1] ?? new Uint8Array()))

        const missing = yield* Effect.flip(relayer.sign({ signer: payer.signer, instructions, ...explicit }))
        expect(missing).toMatchObject({
          _tag: "SolanaSignerError",
          cause: new Error(`no signer for ${owner.signer.address}`)
        })
        const short = { ...owner.signer, signTransactionMessage: () => Effect.succeed(new Uint8Array(63)) }
        const malformed = yield* Effect.flip(
          relayer.sign({ signer: payer.signer, cosigners: [short], instructions, ...explicit })
        )
        expect(malformed._tag).toBe("SolanaSignerError")
        const invalid = yield* Effect.flip(relayer.sign({
          signer: payer.signer,
          cosigners: [owner.signer],
          instructions,
          ...explicit,
          blockhash: { blockhash: "not a blockhash", lastValidBlockHeight: BigInt(1) }
        }))
        expect(invalid._tag).toBe("SolanaSignerError")
      })
    )
  })

  it.effect("broadcasts with a preflight at confirmed and returns the node's hash", () => {
    const { run, state } = setup()
    return run((relayer) => relayer.broadcast({ signed: "AQ==" })).pipe(Effect.map((hash) => {
      expect(hash).toBe(HASH)
      expect(state.calls).toStrictEqual([["sendTransaction", {
        transaction: "AQ==",
        preflightCommitment: "confirmed"
      }]])
    }))
  })

  it.effect("leaves a refusal that is not a preflight failure as it is", () => {
    const refused = refusal(-32003)
    const { run, state } = setup({ send: Effect.fail(refused) })
    return Effect.flip(run((relayer) => relayer.broadcast({ signed: "AQ==" }))).pipe(Effect.map((error) => {
      expect(error).toBe(refused)
      expect(state.calls.map(([name]) => name)).toStrictEqual(["sendTransaction"])
    }))
  })

  it.effect("maps a preflight failure to its reason by simulating the transaction again", () =>
    Effect.gen(function*() {
      const { signer } = yield* signerOf(1)
      const sign = (relayer: SolanaRelayer.SolanaRelayer["Service"]) =>
        relayer.sign({ signer, instructions: [transfer(signer.address, TO)], ...explicit })
      const refuse = (simulation: Partial<SolanaRpc.SolanaSimulation>) => {
        const { run, state } = setup({ send: Effect.fail(preflight), simulation })
        return run((relayer) =>
          Effect.gen(function*() {
            const sent = yield* sign(relayer)
            const result = yield* Effect.result(relayer.broadcast(sent))
            expect(state.calls).toStrictEqual([
              ["sendTransaction", { transaction: sent.signed, preflightCommitment: "confirmed" }],
              ["simulateTransaction", { transaction: sent.signed, commitment: "confirmed", sigVerify: true }]
            ])
            return { sent, result }
          })
        )
      }
      // the node has already processed these bytes
      const known = yield* refuse({ err: "AlreadyProcessed" })
      expect(known.result).toMatchObject({ _tag: "Success", success: known.sent.hash })
      const reasons = [
        ["BlockhashNotFound", { _tag: "BlockhashNotFound" }],
        ["InsufficientFundsForFee", { _tag: "InsufficientFunds" }],
        ["AccountNotFound", { _tag: "InsufficientFunds" }],
        ["AccountInUse", { _tag: "SimulationFailed", error: "AccountInUse", logs: [] }]
      ] as const
      for (const [err, reason] of reasons) {
        const { result } = yield* refuse({ err })
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "SolanaBroadcastError", reason, cause: preflight }
        })
      }
      const failed = yield* refuse({ err: { InstructionError: [2, { Custom: 1 }] }, logs: ["log"] })
      expect(failed.result).toMatchObject({
        _tag: "Failure",
        failure: {
          reason: { _tag: "SimulationFailed", error: { InstructionError: [2, { Custom: 1 }] }, logs: ["log"] }
        }
      })
      // the second simulation passes: the refusal is all that is known
      const passing = yield* refuse({ err: null })
      expect(passing.result).toMatchObject({ _tag: "Failure", failure: preflight })
    }))
})
