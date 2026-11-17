import { StellarAccountAddress } from "@effect-blockchain/stellar/StellarAddress"
import * as StellarRelayer from "@effect-blockchain/stellar/StellarRelayer"
import * as StellarRpc from "@effect-blockchain/stellar/StellarRpc"
import * as StellarSigner from "@effect-blockchain/stellar/StellarSigner"
import { StellarTransactionHash } from "@effect-blockchain/stellar/StellarTransactionHash"
import { describe, expect, it, vi } from "@effect/vitest"
import {
  Account,
  Asset,
  FeeBumpTransaction,
  Keypair,
  Networks,
  Operation,
  SorobanDataBuilder,
  StrKey,
  TransactionBuilder,
  xdr
} from "@stellar/stellar-sdk"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { account, accountKey } from "./utils/ledgerMeta.ts"

const keypair = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1))
const ADDRESS = StellarAccountAddress.make(keypair.publicKey())
const HASH = StellarTransactionHash.make("0x" + "cd".repeat(32))
const PAYMENT = Operation.payment({
  destination: Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2)).publicKey(),
  asset: Asset.native(),
  amount: "1"
}).toXDR("base64")

const signer = StellarSigner.fromHashSigner({
  address: ADDRESS,
  signHash: (hash) => Effect.succeed(new Uint8Array(keypair.sign(Buffer.from(hash.slice(2), "hex"))))
})

const accountEntry = (sequence: number) => {
  const entry = account(ADDRESS, 7)
  entry.data().account().seqNum(xdr.Int64.fromString(String(sequence)))
  return { xdr: entry.data().toXDR("base64"), lastModifiedLedger: BigInt(1) }
}

const fees = (fee: number, p90 = fee): StellarRelayer.StellarFeeEstimate => {
  const stroops = BigInt(fee)
  return {
    max: stroops,
    min: stroops,
    mode: stroops,
    p10: stroops,
    p20: stroops,
    p30: stroops,
    p40: stroops,
    p50: stroops,
    p60: stroops,
    p70: stroops,
    p80: stroops,
    p90: BigInt(p90),
    p95: stroops,
    p99: stroops,
    transactionCount: 1,
    ledgerCount: 1
  }
}

// TransactionResult: a fee of 100 stroops, the result code and an empty extension
const resultXdr = (code: number) => {
  const bytes = Buffer.alloc(16)
  bytes.writeBigInt64BE(BigInt(100), 0)
  bytes.writeInt32BE(code, 8)
  return bytes.toString("base64")
}
const TX_BAD_SEQ = -5
const TX_INSUFFICIENT_BALANCE = -7
const TX_INSUFFICIENT_FEE = -9

interface Node {
  // the account's sequence number, `undefined` for an account that does not exist
  readonly sequence?: number
  readonly p90?: number
  readonly sent?: Pick<StellarRpc.StellarSentTransaction, "status" | "errorResultXdr">
  readonly inLedger?: boolean
  readonly simulation?: StellarRpc.StellarSimulation
}

const setup = <E = never>(
  node: Node,
  options?: Parameters<typeof StellarRelayer.layer>[0],
  relayer: Layer.Layer<StellarRelayer.StellarRelayer, E, StellarRpc.StellarRpc> = StellarRelayer.layer(options)
) => {
  const calls: Array<string> = []
  const read: Array<string> = []
  const range = { latestLedger: BigInt(100), oldestLedger: BigInt(1) }
  const rpc = Layer.succeed(
    StellarRpc.StellarRpc,
    StellarRpc.StellarRpc.of({
      network: "StellarTestnet",
      getNetwork: Effect.die("unused"),
      getLatestLedger: Effect.die("unused"),
      getEvents: () => Effect.die("unused"),
      getLedgers: () => Effect.die("unused"),
      getLedgerEntries: ({ keys }) =>
        Effect.sync(() => {
          calls.push("getLedgerEntries")
          read.push(...keys)
          return {
            entries: node.sequence === undefined ? [] : [accountEntry(node.sequence)],
            latestLedger: BigInt(100)
          }
        }),
      getFeeStats: Effect.sync(() => {
        calls.push("getFeeStats")
        return { inclusionFee: fees(0, node.p90 ?? 0), sorobanInclusionFee: fees(9999), latestLedger: BigInt(100) }
      }),
      simulateTransaction: () =>
        Effect.sync(() => {
          calls.push("simulateTransaction")
          return node.simulation ?? { error: "unused", latestLedger: BigInt(100) }
        }),
      sendTransaction: () =>
        Effect.sync(() => {
          calls.push("sendTransaction")
          return { status: "PENDING", hash: HASH, latestLedger: BigInt(100), ...node.sent }
        }),
      getTransaction: () =>
        Effect.sync((): StellarRpc.StellarTransactionInfo => {
          calls.push("getTransaction")
          return node.inLedger !== true ? { status: "NOT_FOUND", ...range } : {
            status: "SUCCESS",
            ...range,
            ledger: BigInt(90),
            createdAt: 1794833332,
            applicationOrder: 1,
            feeBump: false,
            envelopeXdr: "",
            resultXdr: resultXdr(0),
            resultMetaXdr: ""
          }
        })
    })
  )
  const run = <A, E>(f: (relayer: StellarRelayer.StellarRelayer["Service"]) => Effect.Effect<A, E>) =>
    Effect.gen(function*() {
      return yield* f(yield* StellarRelayer.StellarRelayer)
    }).pipe(Effect.provide(relayer.pipe(Layer.provide(rpc))))
  return { calls, read, run }
}

const decode = (signed: string) => {
  const transaction = TransactionBuilder.fromXDR(signed, Networks.TESTNET)
  if (transaction instanceof FeeBumpTransaction) throw new Error("not a transaction")
  return transaction
}

const CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 3))
const INVOCATION = Operation.invokeContractFunction({ contract: CONTRACT, function: "transfer", args: [] })
const authEntry = (credentials: xdr.SorobanCredentials) =>
  new xdr.SorobanAuthorizationEntry({
    credentials,
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        INVOCATION.body().invokeHostFunctionOp().hostFunction().invokeContract()
      ),
      subInvocations: []
    })
  })
const SOURCE_AUTH = authEntry(xdr.SorobanCredentials.sorobanCredentialsSourceAccount())
const ADDRESS_AUTH = authEntry(xdr.SorobanCredentials.sorobanCredentialsAddress(
  new xdr.SorobanAddressCredentials({
    address: xdr.ScAddress.scAddressTypeAccount(Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2)).xdrAccountId()),
    nonce: xdr.Int64.fromString("1"),
    signatureExpirationLedger: 0,
    signature: xdr.ScVal.scvVoid()
  })
))
const simulation = (auth: xdr.SorobanAuthorizationEntry): StellarRpc.StellarSimulation => ({
  transactionData: new SorobanDataBuilder().setResourceFee("5000").build().toXDR("base64"),
  minResourceFee: BigInt(5000),
  results: [{ auth: [auth.toXDR("base64")], xdr: xdr.ScVal.scvVoid().toXDR("base64") }],
  latestLedger: BigInt(100)
})
const authOf = (signed: string) => {
  const operation = decode(signed).operations[0]
  return operation.type === "invokeHostFunction" ? (operation.auth ?? []).map((entry) => entry.toXDR("base64")) : []
}

const broadcast = (node: Node) => {
  const { calls, run } = setup(node)
  return Effect.map(Effect.result(run((relayer) => relayer.broadcast({ signed: "AAAA" }))), (result) => ({
    calls,
    result
  }))
}

describe("StellarRelayer sign", () => {
  it.effect("defaults the sequence number, the fee and maxLedger", () =>
    Effect.gen(function*() {
      const { calls, run } = setup({ sequence: 41 })
      const signed = yield* run((relayer) => relayer.sign({ signer, operations: [PAYMENT, PAYMENT] }))
      const transaction = decode(signed.signed)
      expect(signed).toStrictEqual({
        hash: `0x${transaction.hash().toString("hex")}`,
        signed: signed.signed,
        sequence: BigInt(42),
        maxLedger: BigInt(160)
      })
      expect(transaction.source).toBe(ADDRESS)
      expect(transaction.sequence).toBe("42")
      // 100 stroops per operation: the recent fees are below the network's minimum
      expect(transaction.fee).toBe("200")
      expect(transaction.ledgerBounds).toStrictEqual({ minLedger: 0, maxLedger: 160 })
      expect(transaction.timeBounds).toStrictEqual({ minTime: "0", maxTime: "0" })
      expect(transaction.operations).toHaveLength(2)
      expect(keypair.verify(transaction.hash(), transaction.signatures[0].signature())).toBe(true)
      expect(calls.slice().sort()).toStrictEqual(["getFeeStats", "getLedgerEntries"])
    }))

  it.effect("prices with the 90th percentile, or with the layer's strategy and validity", () =>
    Effect.gen(function*() {
      const options = { signer, operations: [PAYMENT] } as const
      const surge = yield* setup({ sequence: 41, p90: 5000 }).run((relayer) => relayer.sign(options))
      expect(decode(surge.signed).fee).toBe("5000")
      const custom = yield* setup({ sequence: 41, p90: 5000 }, {
        fees: (estimate) => ({ fee: estimate.p90 * BigInt(2) }),
        validity: 10
      }).run((relayer) => relayer.sign(options))
      expect(decode(custom.signed).fee).toBe("10000")
      expect(custom.maxLedger).toBe(BigInt(110))
      const configured = yield* setup(
        { sequence: 41 },
        undefined,
        StellarRelayer.layerConfig({ validity: Config.succeed(20) })
      ).run((relayer) => relayer.sign(options))
      expect(configured.maxLedger).toBe(BigInt(120))
    }))

  it.effect("keeps an explicit sequence number, fee and maxLedger", () =>
    Effect.gen(function*() {
      // an account that does not exist yet is not read for its sequence number
      const { calls, run } = setup({})
      const signed = yield* run((relayer) =>
        relayer.sign({
          signer,
          operations: [PAYMENT],
          sequence: BigInt(7),
          fees: { fee: BigInt(300) },
          maxLedger: BigInt(105)
        })
      )
      const transaction = decode(signed.signed)
      expect([signed.sequence, signed.maxLedger]).toStrictEqual([BigInt(7), BigInt(105)])
      expect([transaction.sequence, transaction.fee, transaction.ledgerBounds?.maxLedger]).toStrictEqual([
        "7",
        "300",
        105
      ])
      expect(calls).toStrictEqual(["getLedgerEntries"])
    }))

  it.effect("fails with a StellarSignerError on a missing account, a broken operation and a broken signer", () =>
    Effect.gen(function*() {
      const missing = yield* Effect.flip(setup({}).run((relayer) => relayer.sign({ signer, operations: [PAYMENT] })))
      expect(String(missing.cause)).toContain("does not exist")
      const broken = yield* Effect.flip(
        setup({ sequence: 41 }).run((relayer) => relayer.sign({ signer, operations: ["not XDR"] }))
      )
      expect(broken._tag).toBe("StellarSignerError")
      const garbage = { address: ADDRESS, signTransaction: () => Effect.succeed("not XDR") }
      const unsigned = yield* Effect.flip(
        setup({ sequence: 41 }).run((relayer) => relayer.sign({ signer: garbage, operations: [PAYMENT] }))
      )
      expect(unsigned._tag).toBe("StellarSignerError")
    }))
})

describe("StellarRelayer broadcast", () => {
  it.effect("returns the hash of a transaction the node took or already holds", () =>
    Effect.gen(function*() {
      for (const status of ["PENDING", "DUPLICATE"] as const) {
        const { calls, result } = yield* broadcast({ sent: { status } })
        expect(result).toMatchObject({ _tag: "Success", success: HASH })
        expect(calls).toStrictEqual(["sendTransaction"])
      }
    }))

  it.effect("is a success when the node refuses a transaction it has in a ledger", () =>
    Effect.gen(function*() {
      for (
        const sent of [
          { status: "TRY_AGAIN_LATER" },
          { status: "ERROR", errorResultXdr: resultXdr(TX_BAD_SEQ) }
        ] as const
      ) {
        const { calls, result } = yield* broadcast({ sent, inLedger: true })
        expect(result).toMatchObject({ _tag: "Success", success: HASH })
        expect(calls).toStrictEqual(["sendTransaction", "getTransaction"])
      }
    }))

  it.effect("maps TRY_AGAIN_LATER and a refusal to a reason", () =>
    Effect.gen(function*() {
      const later = yield* broadcast({ sent: { status: "TRY_AGAIN_LATER" } })
      expect(later.result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "StellarBroadcastError", reason: { _tag: "TryAgainLater" } }
      })
      const badSeq = yield* broadcast({ sent: { status: "ERROR", errorResultXdr: resultXdr(TX_BAD_SEQ) } })
      expect(badSeq.result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "StellarBroadcastError", reason: { _tag: "InvalidNonce" } }
      })
      const balance = yield* broadcast({
        sent: { status: "ERROR", errorResultXdr: resultXdr(TX_INSUFFICIENT_BALANCE) }
      })
      expect(balance.result).toMatchObject({
        _tag: "Failure",
        failure: { reason: { _tag: "InsufficientFunds" }, cause: { message: expect.stringContaining("ERROR") } }
      })
      expect(balance.calls).toStrictEqual(["sendTransaction"])
      const fee = yield* broadcast({ sent: { status: "ERROR", errorResultXdr: resultXdr(TX_INSUFFICIENT_FEE) } })
      expect(fee.result).toMatchObject({ _tag: "Failure", failure: { reason: { code: "txInsufficientFee" } } })
      // only a used sequence number can mean the transaction is in a ledger
      expect(fee.calls).toStrictEqual(["sendTransaction"])
      const unknown = yield* broadcast({ sent: { status: "ERROR" } })
      expect(unknown.result).toMatchObject({
        _tag: "Failure",
        failure: { reason: { _tag: "Refused", code: undefined, operations: [] } }
      })
    }))

  it.effect("drops a result code the schemas do not list instead of failing", () =>
    Effect.gen(function*() {
      const decoded = (code: string, operations: ReadonlyArray<string>) => ({
        result: () => ({
          switch: () => ({ name: code }),
          results: () => operations.map((name) => ({ switch: () => ({ name }) }))
        })
      })
      const fromXDR = vi.spyOn(xdr.TransactionResult, "fromXDR")
      fromXDR.mockReturnValueOnce(decoded("txFromTheFuture", []) as never)
      const transaction = yield* broadcast({ sent: { status: "ERROR", errorResultXdr: "AAAA" } })
      expect(transaction.result).toMatchObject({
        _tag: "Failure",
        failure: { reason: { _tag: "Refused", code: undefined, operations: [] } }
      })
      fromXDR.mockReturnValueOnce(decoded("txFailed", ["opFromTheFuture", "opBadAuth"]) as never)
      const operation = yield* broadcast({ sent: { status: "ERROR", errorResultXdr: "AAAA" } })
      expect(operation.result).toMatchObject({
        _tag: "Failure",
        failure: { reason: { _tag: "Refused", code: "txFailed", operations: [undefined, "opBadAuth"] } }
      })
      fromXDR.mockRestore()
    }))
})

describe("StellarRelayer sign of a Soroban invocation", () => {
  const operations = [INVOCATION.toXDR("base64")] as const

  it.effect("takes the footprint, the resource fee and the authorization entries of the simulation", () =>
    Effect.gen(function*() {
      const { calls, run } = setup({ sequence: 41, simulation: simulation(SOURCE_AUTH) })
      const signed = yield* run((relayer) => relayer.sign({ signer, operations }))
      const transaction = decode(signed.signed)
      // the Soroban inclusion fee of the fake, plus the resource fee
      expect(transaction.fee).toBe("14999")
      expect(transaction.toEnvelope().v1().tx().ext().sorobanData().resourceFee().toString()).toBe("5000")
      expect(authOf(signed.signed)).toStrictEqual([SOURCE_AUTH.toXDR("base64")])
      expect(signed.hash).toBe(`0x${transaction.hash().toString("hex")}`)
      expect(keypair.verify(transaction.hash(), transaction.signatures[0].signature())).toBe(true)
      expect(calls.slice().sort()).toStrictEqual(["getFeeStats", "getLedgerEntries", "simulateTransaction"])
      const explicit = yield* run((relayer) => relayer.sign({ signer, operations, fees: { fee: BigInt(100) } }))
      expect(decode(explicit.signed).fee).toBe("5100")
    }))

  it.effect("keeps the authorization entries the operation comes with", () =>
    Effect.gen(function*() {
      const authorized = xdr.Operation.fromXDR(INVOCATION.toXDR())
      authorized.body().invokeHostFunctionOp().auth([ADDRESS_AUTH])
      const signed = yield* setup({ sequence: 41, simulation: simulation(SOURCE_AUTH) }).run((relayer) =>
        relayer.sign({ signer, operations: [authorized.toXDR("base64")] })
      )
      expect(authOf(signed.signed)).toStrictEqual([ADDRESS_AUTH.toXDR("base64")])
    }))

  it.effect("fails on a failed simulation and on an entry another address must sign", () =>
    Effect.gen(function*() {
      const failed = yield* Effect.flip(
        setup({ sequence: 41, simulation: { error: "HostError", latestLedger: BigInt(100) } }).run((relayer) =>
          relayer.sign({ signer, operations })
        )
      )
      expect(failed).toMatchObject({
        _tag: "StellarSimulationError",
        reason: { _tag: "SimulationFailed", error: "HostError" }
      })
      const foreign = yield* Effect.flip(
        setup({ sequence: 41, simulation: simulation(ADDRESS_AUTH) }).run((relayer) =>
          relayer.sign({ signer, operations })
        )
      )
      expect(foreign).toMatchObject({ _tag: "StellarSimulationError", reason: { _tag: "UnsupportedAuth" } })
    }))

  it.effect("fails before signing when the simulation asks to restore archived entries", () =>
    Effect.gen(function*() {
      const restorePreamble = { transactionData: "AAAA", minResourceFee: BigInt(700) }
      const archived = yield* Effect.flip(
        setup({ sequence: 41, simulation: { ...simulation(SOURCE_AUTH), restorePreamble } }).run((relayer) =>
          relayer.sign({ signer: { address: ADDRESS, signTransaction: () => Effect.die("signed") }, operations })
        )
      )
      expect(archived).toMatchObject({
        _tag: "StellarSimulationError",
        reason: { _tag: "RestoreRequired", ...restorePreamble }
      })
    }))
})

describe("StellarRelayer feeBump", () => {
  const payer = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 4))
  const sponsor = StellarSigner.fromHashSigner({
    address: StellarAccountAddress.make(payer.publicKey()),
    signHash: (hash) => Effect.succeed(new Uint8Array(payer.sign(Buffer.from(hash.slice(2), "hex"))))
  })
  const bump = (
    node: Node,
    inner: { readonly operations: readonly [string, ...Array<string>]; readonly fee: number }
  ) =>
    Effect.gen(function*() {
      const { calls, run } = setup({ sequence: 41, ...node })
      const signed = yield* run((relayer) =>
        relayer.sign({ signer, operations: inner.operations, fees: { fee: BigInt(inner.fee) } })
      )
      calls.length = 0
      return { calls, run, signed }
    })

  it.effect("wraps a signed transaction and prices the bump from the fee statistics", () =>
    Effect.gen(function*() {
      const { calls, run, signed } = yield* bump({ p90: 5000 }, { operations: [PAYMENT, PAYMENT], fee: 100 })
      const bumped = yield* run((relayer) => relayer.feeBump({ signer: sponsor, signed: signed.signed }))
      const transaction = TransactionBuilder.fromXDR(bumped.signed, Networks.TESTNET)
      if (!(transaction instanceof FeeBumpTransaction)) throw new Error("not a fee bump")
      expect(bumped.hash).toBe(`0x${transaction.hash().toString("hex")}`)
      expect(bumped.hash).not.toBe(signed.hash)
      expect([bumped.sequence, bumped.maxLedger]).toStrictEqual([signed.sequence, signed.maxLedger])
      expect(transaction.feeSource).toBe(payer.publicKey())
      // 5000 stroops for each of the two operations and for the fee bump
      expect(transaction.fee).toBe("15000")
      expect(`0x${transaction.innerTransaction.hash().toString("hex")}`).toBe(signed.hash)
      expect(payer.verify(transaction.hash(), transaction.signatures[0].signature())).toBe(true)
      expect(calls).toStrictEqual(["getFeeStats"])
    }))

  it.effect("offers at least the fee of the inner transaction, and keeps an explicit fee", () =>
    Effect.gen(function*() {
      const { calls, run, signed } = yield* bump({}, { operations: [PAYMENT], fee: 700 })
      const bumped = yield* run((relayer) => relayer.feeBump({ signer: sponsor, signed: signed.signed }))
      expect(TransactionBuilder.fromXDR(bumped.signed, Networks.TESTNET).fee).toBe("1400")
      calls.length = 0
      const explicit = yield* run((relayer) =>
        relayer.feeBump({ signer: sponsor, signed: signed.signed, fees: { fee: BigInt(900) } })
      )
      expect(TransactionBuilder.fromXDR(explicit.signed, Networks.TESTNET).fee).toBe("1800")
      expect(calls).toStrictEqual([])
    }))

  it.effect("reports a maxLedger of 0 for an inner transaction without ledger bounds", () =>
    Effect.gen(function*() {
      const unbounded = new TransactionBuilder(new Account(ADDRESS, "41"), {
        fee: "100",
        networkPassphrase: Networks.TESTNET
      }).addOperation(xdr.Operation.fromXDR(PAYMENT, "base64")).setTimeout(0).build()
      unbounded.sign(keypair)
      const bumped = yield* setup({}).run((relayer) =>
        relayer.feeBump({ signer: sponsor, signed: unbounded.toEnvelope().toXDR("base64") })
      )
      expect([bumped.sequence, bumped.maxLedger]).toStrictEqual([BigInt(42), BigInt(0)])
    }))

  it.effect("adds the resource fee of a Soroban invocation once", () =>
    Effect.gen(function*() {
      const { run, signed } = yield* bump({ simulation: simulation(SOURCE_AUTH) }, {
        operations: [INVOCATION.toXDR("base64")],
        fee: 100
      })
      const bumped = yield* run((relayer) => relayer.feeBump({ signer: sponsor, signed: signed.signed }))
      // the Soroban inclusion fee of the fake for the invocation and for the fee bump, plus the resource fee
      expect(TransactionBuilder.fromXDR(bumped.signed, Networks.TESTNET).fee).toBe("24998")
    }))

  it.effect("fails with a StellarSignerError on a fee below the inner one, a fee bump and a broken envelope", () =>
    Effect.gen(function*() {
      const { run, signed } = yield* bump({}, { operations: [PAYMENT], fee: 700 })
      const low = yield* Effect.flip(
        run((relayer) => relayer.feeBump({ signer: sponsor, signed: signed.signed, fees: { fee: BigInt(100) } }))
      )
      expect(low._tag).toBe("StellarSignerError")
      const bumped = yield* run((relayer) => relayer.feeBump({ signer: sponsor, signed: signed.signed }))
      const twice = yield* Effect.flip(run((relayer) => relayer.feeBump({ signer: sponsor, signed: bumped.signed })))
      expect(String(twice.cause)).toContain("already a fee bump")
      const broken = yield* Effect.flip(run((relayer) => relayer.feeBump({ signer: sponsor, signed: "not XDR" })))
      expect(broken._tag).toBe("StellarSignerError")
    }))
})

describe("StellarRelayer sign through a channel", () => {
  const other = (seed: number) => {
    const pair = Keypair.fromRawEd25519Seed(Buffer.alloc(32, seed))
    const address = StellarAccountAddress.make(pair.publicKey())
    return {
      address,
      hint: pair.signatureHint().toString("hex"),
      signer: StellarSigner.fromHashSigner({
        address,
        signHash: (hash) => Effect.succeed(new Uint8Array(pair.sign(Buffer.from(hash.slice(2), "hex"))))
      })
    }
  }
  const channel = other(5)
  const third = other(6)
  const hints = (signed: string) => decode(signed).signatures.map((signature) => signature.hint().toString("hex"))

  it.effect("uses the channel as the source and the signer as the source of the operations", () =>
    Effect.gen(function*() {
      const { read, run } = setup({ sequence: 41 })
      const sourced = Operation.payment({
        destination: ADDRESS,
        asset: Asset.native(),
        amount: "1",
        source: third.address
      }).toXDR("base64")
      const signed = yield* run((relayer) =>
        relayer.sign({ signer, channel: channel.signer, operations: [PAYMENT, sourced] })
      )
      const transaction = decode(signed.signed)
      expect(transaction.source).toBe(channel.address)
      // the sequence number of the channel, the only account read
      expect([transaction.sequence, signed.sequence]).toStrictEqual(["42", BigInt(42)])
      expect(read).toStrictEqual([accountKey(channel.address).toXDR("base64")])
      expect(transaction.operations.map((operation) => operation.source)).toStrictEqual([ADDRESS, third.address])
      expect(hints(signed.signed)).toStrictEqual([channel.hint, keypair.signatureHint().toString("hex")])
    }))

  it.effect("leaves the operations without a source and adds the cosigners without a channel", () =>
    Effect.gen(function*() {
      const signed = yield* setup({ sequence: 41 }).run((relayer) =>
        relayer.sign({ signer, operations: [PAYMENT], cosigners: [third.signer, channel.signer] })
      )
      expect(decode(signed.signed).operations[0].source).toBeUndefined()
      expect(hints(signed.signed)).toStrictEqual([keypair.signatureHint().toString("hex"), third.hint, channel.hint])
    }))

  it("createSponsoredAccount opens the sponsorship, creates the account and closes it", () => {
    const operations = StellarRelayer.createSponsoredAccount({ sponsor: ADDRESS, account: third.address }).map((
      operation
    ) => Operation.fromXDRObject(xdr.Operation.fromXDR(operation, "base64")))
    expect(operations).toMatchObject([
      { type: "beginSponsoringFutureReserves", source: ADDRESS, sponsoredId: third.address },
      { type: "createAccount", source: ADDRESS, destination: third.address, startingBalance: "0.0000000" },
      { type: "endSponsoringFutureReserves", source: third.address }
    ])
  })
})
