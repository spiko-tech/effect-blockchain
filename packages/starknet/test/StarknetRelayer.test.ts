import * as JsonRpc from "@effect-blockchain/core/JsonRpc"
import { StarknetAddress } from "@effect-blockchain/starknet/StarknetAddress"
import { STRK_TOKEN_ADDRESS } from "@effect-blockchain/starknet/StarknetNetwork"
import * as StarknetRelayer from "@effect-blockchain/starknet/StarknetRelayer"
import * as StarknetRpc from "@effect-blockchain/starknet/StarknetRpc"
import * as StarknetSigner from "@effect-blockchain/starknet/StarknetSigner"
import type { StarknetTransaction } from "@effect-blockchain/starknet/StarknetTransaction"
import { StarknetTransactionHash } from "@effect-blockchain/starknet/StarknetTransactionHash"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as TestClock from "effect/testing/TestClock"
import { hash as starknetHash } from "starknet"

const HASH = StarknetTransactionHash.make("0x" + "cd".repeat(32))

type Finality = StarknetRpc.StarknetTransactionStatusResult["finalityStatus"]

interface Node {
  readonly head: number
  readonly status?: StarknetRpc.StarknetTransactionStatusResult | undefined
  // the block of the receipt, a missing one answers `TXN_HASH_NOT_FOUND`
  readonly block?: number | undefined
}

const accepted = (
  block: number,
  finalityStatus: Finality = "ACCEPTED_ON_L2"
): Pick<Node, "status" | "block"> => ({ status: { finalityStatus, executionStatus: "SUCCEEDED" }, block })

const reverted = (block: number): Pick<Node, "status" | "block"> => ({
  status: { finalityStatus: "ACCEPTED_ON_L2", executionStatus: "REVERTED", failureReason: "out of gas" },
  block
})

// a fake service answering from `node.current`, which a test replaces between polls
const setup = (initial: Node, options?: Parameters<typeof StarknetRelayer.layer>[0]) => {
  const node = { current: initial, polls: 0 }
  const rpc = Layer.succeed(
    StarknetRpc.StarknetRpc,
    StarknetRpc.StarknetRpc.of({
      network: "Starknet",
      chainId: Effect.die("unused"),
      blockNumber: Effect.sync(() => BigInt(node.current.head)),
      getBlockWithTxHashes: () => Effect.die("unused"),
      getEvents: () => Effect.die("unused"),
      call: () => Effect.die("unused"),
      getNonce: () => Effect.die("unused"),
      estimateFee: () => Effect.die("unused"),
      addInvokeTransaction: () => Effect.die("unused"),
      addDeployAccountTransaction: () => Effect.die("unused"),
      getTransactionStatus: () =>
        Effect.sync(() => {
          node.polls++
          return node.current.status ?? null
        }),
      getTransactionReceipt: ({ transactionHash }) =>
        Effect.suspend(() =>
          node.current.block === undefined
            ? Effect.die("no receipt")
            : Effect.succeed({
              transactionHash,
              blockNumber: BigInt(node.current.block),
              blockHash: "0x" + "ab".repeat(32),
              events: []
            })
        )
    })
  )
  const run = <A, E>(f: (relayer: StarknetRelayer.StarknetRelayer["Service"]) => Effect.Effect<A, E>) =>
    Effect.gen(function*() {
      return yield* f(yield* StarknetRelayer.StarknetRelayer)
    }).pipe(Effect.provide(StarknetRelayer.layer(options).pipe(Layer.provide(rpc))))
  return { node, run }
}

const statusOf = (node: Node, options?: Parameters<typeof StarknetRelayer.layer>[0]) =>
  setup(node, options).run((relayer) => relayer.fetchTransactionStatus({ hash: HASH }))

describe("StarknetRelayer", () => {
  it.effect("maps what the node knows to a status", () =>
    Effect.gen(function*() {
      expect(yield* statusOf({ head: 100 })).toStrictEqual({ _tag: "NotFound" })
      // not in an accepted block: the receipt is not read
      for (const finalityStatus of ["RECEIVED", "CANDIDATE", "PRE_CONFIRMED"] as const) {
        expect(yield* statusOf({ head: 100, status: { finalityStatus } })).toStrictEqual({ _tag: "Pending" })
      }
      // Starknet confirms an accepted block at once: a head at the block confirms it, a head read behind does not
      expect(yield* statusOf({ head: 99, ...accepted(100) })).toStrictEqual({ _tag: "Included", block: BigInt(100) })
      expect(yield* statusOf({ head: 100, ...accepted(100) })).toStrictEqual({ _tag: "Confirmed", block: BigInt(100) })
      expect(yield* statusOf({ head: 100, ...accepted(100, "ACCEPTED_ON_L1") })).toStrictEqual({
        _tag: "Confirmed",
        block: BigInt(100)
      })
    }))

  it.effect("reports a revert as Failed only once its block is confirmed", () =>
    Effect.gen(function*() {
      expect(yield* statusOf({ head: 99, ...reverted(100) })).toStrictEqual({ _tag: "Included", block: BigInt(100) })
      expect(yield* statusOf({ head: 100, ...reverted(100) })).toStrictEqual({
        _tag: "Failed",
        block: BigInt(100),
        reason: "out of gas"
      })
      expect(
        yield* statusOf({
          head: 100,
          status: { finalityStatus: "ACCEPTED_ON_L2", executionStatus: "REVERTED" },
          block: 100
        })
      ).toStrictEqual({ _tag: "Failed", block: BigInt(100), reason: undefined })
    }))

  it.effect("uses the confirmations option, also for a block accepted on L1", () =>
    Effect.gen(function*() {
      const options = { confirmations: 2 }
      expect((yield* statusOf({ head: 101, ...accepted(100) }, options))._tag).toBe("Included")
      expect((yield* statusOf({ head: 101, ...accepted(100, "ACCEPTED_ON_L1") }, options))._tag).toBe("Included")
      expect((yield* statusOf({ head: 102, ...accepted(100) }, options))._tag).toBe("Confirmed")
    }))

  it.effect("awaitConfirmation polls every 10 seconds until the transaction is confirmed", () => {
    const { node, run } = setup({ head: 100 })
    return run((relayer) =>
      Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(relayer.awaitConfirmation({ hash: HASH }))
        yield* TestClock.adjust(0)
        expect(node.polls).toBe(1)
        node.current = { head: 100, status: { finalityStatus: "RECEIVED" } }
        yield* TestClock.adjust("9 seconds")
        expect(node.polls).toBe(1)
        yield* TestClock.adjust("1 second")
        expect(node.polls).toBe(2)
        node.current = { head: 100, ...accepted(101) }
        yield* TestClock.adjust("10 seconds")
        expect(node.polls).toBe(3)
        expect(fiber.pollUnsafe()).toBeUndefined()
        node.current = { head: 101, ...accepted(101) }
        yield* TestClock.adjust("10 seconds")
        expect(yield* Fiber.join(fiber)).toStrictEqual({ _tag: "Confirmed", block: BigInt(101) })
        expect(node.polls).toBe(4)
      })
    )
  })

  it.effect("awaitConfirmation returns a confirmed revert, and the last status when poll ends first", () =>
    Effect.gen(function*() {
      const failed = setup({ head: 100, ...reverted(100) })
      expect((yield* failed.run((relayer) => relayer.awaitConfirmation({ hash: HASH })))._tag).toBe("Failed")
      expect(failed.node.polls).toBe(1)
      const unknown = setup({ head: 100 })
      expect(
        yield* unknown.run((relayer) => relayer.awaitConfirmation({ hash: HASH, poll: Schedule.recurs(2) }))
      ).toStrictEqual({ _tag: "NotFound" })
      expect(unknown.node.polls).toBe(3)
    }))
})

// the first predeployed account of `starknet-devnet --seed 0`: a public key, never funded on a real network
const KEY = Redacted.make("0x71d7bb07b9a64f6f78ac4c816aff4da9")
const PUBLIC_KEY = "0x39d9e6ce352ad4530a0ef5d5a18fd3303c3606a7fa6ac5b620020ad681cc33b"
const ADDRESS = StarknetAddress.make("0x064b48806902a367c8598f4f95c305e8c1a1acba5f082d294a43793113115691")
const TO = StarknetAddress.make("0x" + "22".repeat(32))
const CLASS_HASH = "0x05b4b537eaa2399e3aa99c4e2e0208ebd6c71bc1467938cd52c798c601e43564"
const DEPLOYED = Schema.decodeSync(StarknetAddress)(
  starknetHash.calculateContractAddressFromHash(PUBLIC_KEY, CLASS_HASH, [PUBLIC_KEY], 0)
)

const ESTIMATE: StarknetRpc.StarknetFeeEstimate = {
  l1GasConsumed: BigInt(0),
  l1GasPrice: BigInt(1000),
  l1DataGasConsumed: BigInt(192),
  l1DataGasPrice: BigInt(2000),
  l2GasConsumed: BigInt(900_000),
  l2GasPrice: BigInt(3000),
  overallFee: BigInt(2_700_384_000)
}
const BOUNDS = {
  l1Gas: { maxAmount: BigInt(0), maxPricePerUnit: BigInt(1500) },
  l1DataGas: { maxAmount: BigInt(288), maxPricePerUnit: BigInt(3000) },
  l2Gas: { maxAmount: BigInt(1_800_000), maxPricePerUnit: BigInt(4500) }
}
const NO_BOUND = { maxAmount: BigInt(0), maxPricePerUnit: BigInt(0) }
const calls = [{ contractAddress: STRK_TOKEN_ADDRESS, entrypoint: "transfer", calldata: [TO, "0x1", "0x0"] }]

const refused = (code?: number, reason: JsonRpc.Reason = new JsonRpc.Rejected(), cause: unknown = new Error("no")) =>
  new StarknetRpc.StarknetRpcError({ reason, method: "starknet_addInvokeTransaction", endpoint: "fake", code, cause })

// a fake node: `add` answers both `add*Transaction` methods, `known` is whether it has the transaction
const sender = (
  node: {
    readonly add?: Effect.Effect<StarknetTransactionHash, StarknetRpc.StarknetRpcError> | undefined
    readonly known?: boolean | undefined
  } = {},
  options?: Parameters<typeof StarknetRelayer.layer>[0]
) => {
  const seen = {
    nonces: Array<Parameters<StarknetRpc.StarknetRpc["Service"]["getNonce"]>[0]>(),
    estimates: Array<Parameters<StarknetRpc.StarknetRpc["Service"]["estimateFee"]>[0]>(),
    added: Array<StarknetTransaction>()
  }
  const add = (transaction: StarknetTransaction) =>
    Effect.suspend(() => {
      seen.added.push(transaction)
      return node.add ?? Effect.succeed(HASH)
    })
  const rpc = Layer.succeed(
    StarknetRpc.StarknetRpc,
    StarknetRpc.StarknetRpc.of({
      network: "StarknetSepolia",
      chainId: Effect.die("unused"),
      blockNumber: Effect.die("unused"),
      getBlockWithTxHashes: () => Effect.die("unused"),
      getEvents: () => Effect.die("unused"),
      call: () => Effect.die("unused"),
      getTransactionReceipt: () => Effect.die("unused"),
      getNonce: (options) => Effect.sync(() => (seen.nonces.push(options), BigInt(7))),
      estimateFee: (options) => Effect.sync(() => (seen.estimates.push(options), [ESTIMATE])),
      addInvokeTransaction: ({ transaction }) => add(transaction),
      addDeployAccountTransaction: ({ transaction }) =>
        Effect.map(add(transaction), (transactionHash) => ({ transactionHash, contractAddress: DEPLOYED })),
      getTransactionStatus: () =>
        Effect.succeed(node.known === true ? { finalityStatus: "ACCEPTED_ON_L2" as const } : null)
    })
  )
  const run = <A, E>(f: (relayer: StarknetRelayer.StarknetRelayer["Service"]) => Effect.Effect<A, E>) =>
    Effect.gen(function*() {
      return yield* f(yield* StarknetRelayer.StarknetRelayer)
    }).pipe(Effect.provide(StarknetRelayer.layer(options).pipe(Layer.provide(rpc))))
  return { seen, run }
}

// records the hash it is asked to sign
const hashSigner = (address = ADDRESS) => {
  const hashes: Array<StarknetTransactionHash> = []
  const signer = StarknetSigner.fromHashSigner({
    address,
    signHash: (hash) => Effect.sync(() => (hashes.push(hash), ["0xa", "0xb"]))
  })
  return { hashes, signer }
}

describe("StarknetRelayer sending", () => {
  it("defaultFees bounds each resource by 1.5 times its amount and price, after the validation allowance", () => {
    expect(StarknetRelayer.defaultFees(ESTIMATE)).toStrictEqual(BOUNDS)
  })

  it.effect("sign reads the nonce at the pre-confirmed block and bounds the estimated resources", () => {
    const { run, seen } = sender()
    const { hashes, signer } = hashSigner()
    return run((relayer) => relayer.sign({ signer, calls })).pipe(Effect.map(({ hash, nonce, signed }) => {
      const unsigned = {
        type: "INVOKE",
        chainId: "SN_SEPOLIA",
        senderAddress: ADDRESS,
        // one call of `transfer`, as `__execute__` of a Cairo 1 account takes it
        calldata: [
          "0x1",
          STRK_TOKEN_ADDRESS,
          "0x83afd3f4caedc6eebf44246fe54e38c95e3179a5ec9ea81740eca5b482d12e",
          "0x3",
          TO,
          "0x1",
          "0x0"
        ],
        nonce: BigInt(7),
        tip: BigInt(0)
      }
      expect(seen.nonces).toStrictEqual([{ address: ADDRESS, blockTag: "pre_confirmed" }])
      expect(seen.estimates).toStrictEqual([{
        transactions: [{
          ...unsigned,
          resourceBounds: { l1Gas: NO_BOUND, l1DataGas: NO_BOUND, l2Gas: NO_BOUND },
          signature: []
        }],
        skipValidate: true,
        blockTag: "pre_confirmed"
      }])
      expect(signed).toStrictEqual({ ...unsigned, resourceBounds: BOUNDS, signature: ["0xa", "0xb"] })
      expect(nonce).toBe(BigInt(7))
      expect(hashes).toStrictEqual([hash])
    }))
  })

  it.effect("sign uses the given nonce, resource bounds and tip, and the layer's fee strategy", () => {
    const given = sender()
    const custom = { ...BOUNDS, l2Gas: { maxAmount: BigInt(5), maxPricePerUnit: BigInt(6) } }
    const strategy = sender({}, {
      fees: (estimate) => ({ ...BOUNDS, l1Gas: { maxAmount: estimate.l2GasPrice, maxPricePerUnit: BigInt(1) } })
    })
    const { signer } = hashSigner()
    return Effect.gen(function*() {
      const explicit = yield* given.run((relayer) =>
        relayer.sign({ signer, calls, nonce: BigInt(3), resourceBounds: custom, tip: BigInt(9) })
      )
      expect(explicit).toMatchObject({
        nonce: BigInt(3),
        signed: { nonce: BigInt(3), resourceBounds: custom, tip: BigInt(9) }
      })
      expect(given.seen).toStrictEqual({ nonces: [], estimates: [], added: [] })
      const priced = yield* strategy.run((relayer) => relayer.sign({ signer, calls }))
      expect(priced.signed.resourceBounds.l1Gas).toStrictEqual({ maxAmount: BigInt(3000), maxPricePerUnit: BigInt(1) })
      expect(priced.hash).not.toBe(explicit.hash)
    })
  })

  it.effect("sign fails with a StarknetSignerError on calldata that is not felts, or when the signer fails", () => {
    const { run } = sender()
    const failing = StarknetSigner.fromHashSigner({ address: ADDRESS, signHash: () => Effect.fail("policy refused") })
    return Effect.gen(function*() {
      const malformed = yield* Effect.flip(
        run((relayer) =>
          relayer.sign({ signer: failing, calls: [{ ...calls[0], calldata: ["not a felt"] }], resourceBounds: BOUNDS })
        )
      )
      expect(malformed).toBeInstanceOf(StarknetSigner.StarknetSignerError)
      expect(yield* Effect.flip(run((relayer) => relayer.sign({ signer: failing, calls })))).toMatchObject({
        _tag: "StarknetSignerError",
        cause: "policy refused"
      })
    })
  })

  it.effect("signDeployAccount signs the deployment of the signer's own address at nonce 0", () => {
    const { run, seen } = sender()
    const account = { classHash: CLASS_HASH, salt: PUBLIC_KEY, constructorCalldata: [PUBLIC_KEY] }
    return Effect.gen(function*() {
      const signer = yield* StarknetSigner.fromPrivateKey({ address: DEPLOYED, key: KEY })
      const { hash, nonce, signed } = yield* run((relayer) => relayer.signDeployAccount({ signer, ...account }))
      expect(nonce).toBe(BigInt(0))
      expect(signed).toMatchObject({
        type: "DEPLOY_ACCOUNT",
        chainId: "SN_SEPOLIA",
        classHash: CLASS_HASH,
        contractAddressSalt: PUBLIC_KEY,
        constructorCalldata: [PUBLIC_KEY],
        nonce: BigInt(0),
        resourceBounds: BOUNDS,
        tip: BigInt(0)
      })
      expect(signed.signature).toHaveLength(2)
      expect(seen.nonces).toStrictEqual([])
      expect(seen.estimates[0]).toMatchObject({ transactions: [{ type: "DEPLOY_ACCOUNT", signature: [] }] })
      const tipped = yield* run((relayer) =>
        relayer.signDeployAccount({ signer, ...account, resourceBounds: BOUNDS, tip: BigInt(1) })
      )
      expect(tipped.hash).not.toBe(hash)
      expect(seen.estimates).toHaveLength(1)
    })
  })

  it.effect("signDeployAccount refuses an account that does not deploy at the signer's address", () => {
    const { run, seen } = sender()
    const { hashes, signer } = hashSigner()
    return Effect.gen(function*() {
      const elsewhere = yield* Effect.flip(
        run((relayer) =>
          relayer.signDeployAccount({
            signer,
            classHash: CLASS_HASH,
            salt: PUBLIC_KEY,
            constructorCalldata: [PUBLIC_KEY]
          })
        )
      )
      expect(elsewhere).toBeInstanceOf(StarknetSigner.StarknetSignerError)
      expect(String(elsewhere.cause)).toContain(`deploys at ${DEPLOYED}`)
      const malformed = yield* Effect.flip(
        run((relayer) =>
          relayer.signDeployAccount({ signer, classHash: "not a felt", salt: "0x1", constructorCalldata: [] })
        )
      )
      expect(malformed).toBeInstanceOf(StarknetSigner.StarknetSignerError)
      expect(hashes).toStrictEqual([])
      expect(seen.estimates).toStrictEqual([])
    })
  })

  const signedBy = (node: Parameters<typeof sender>[0]) => {
    const { run, seen } = sender(node)
    const broadcast = run((relayer) =>
      Effect.gen(function*() {
        const { hash, signed } = yield* relayer.sign({ signer: hashSigner().signer, calls })
        return { hash, sent: yield* Effect.result(relayer.broadcast({ signed })), signed }
      })
    )
    return { broadcast, seen }
  }

  it.effect("broadcast sends an INVOKE or a DEPLOY_ACCOUNT and returns the node's hash", () => {
    const { run, seen } = sender()
    return run((relayer) =>
      Effect.gen(function*() {
        const invoke = yield* relayer.sign({ signer: hashSigner().signer, calls })
        expect(yield* relayer.broadcast(invoke)).toBe(HASH)
        const deployment = yield* relayer.signDeployAccount({
          signer: hashSigner(DEPLOYED).signer,
          classHash: CLASS_HASH,
          salt: PUBLIC_KEY,
          constructorCalldata: [PUBLIC_KEY]
        })
        expect(yield* relayer.broadcast(deployment)).toBe(HASH)
        expect(seen.added).toStrictEqual([invoke.signed, deployment.signed])
      })
    )
  })

  it.effect("broadcast maps the spec's refusals to a reason", () =>
    Effect.gen(function*() {
      const reasons = [
        [52, "InvalidNonce"],
        [53, "InsufficientResources"],
        [54, "InsufficientBalance"],
        [55, "ValidationFailure"],
        [64, "ReplacementUnderpriced"],
        [65, "InsufficientResources"]
      ] as const
      for (const [code, tag] of reasons) {
        const cause = refused(code)
        const { sent } = yield* signedBy({ add: Effect.fail(cause) }).broadcast
        expect(sent).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "StarknetBroadcastError", reason: { _tag: tag }, cause }
        })
      }
      // UNSUPPORTED_TX_VERSION, and an endpoint that is down: nothing the sender acts on
      for (const cause of [refused(61), refused(undefined, new JsonRpc.Unavailable({}))]) {
        const { sent } = yield* signedBy({ add: Effect.fail(cause) }).broadcast
        expect(sent).toMatchObject({ _tag: "Failure", failure: cause })
      }
    }))

  it.effect("broadcast is a success when the node already has the transaction", () =>
    Effect.gen(function*() {
      const duplicate = yield* signedBy({ add: Effect.fail(refused(59)) }).broadcast
      expect(duplicate.sent).toMatchObject({ _tag: "Success", success: duplicate.hash })
      // in a block: the nonce is used, and the node knows the hash
      const included = yield* signedBy({ add: Effect.fail(refused(52)), known: true }).broadcast
      expect(included.sent).toMatchObject({ _tag: "Success", success: included.hash })
      // the first endpoint took it then failed, the second one refuses the copy and the third one is down
      const unavailable = new JsonRpc.Unavailable({})
      const fallback = refused(
        undefined,
        unavailable,
        new AggregateError([new Error("timeout"), refused(59), refused(undefined, unavailable)])
      )
      const retried = yield* signedBy({ add: Effect.fail(fallback) }).broadcast
      expect(retried.sent).toMatchObject({ _tag: "Success", success: retried.hash })
    }))
})
