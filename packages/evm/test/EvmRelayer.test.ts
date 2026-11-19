import * as JsonRpc from "@effect-blockchain/core/JsonRpc"
import * as Replay from "@effect-blockchain/core/test/utils/replay"
import { EvmAddress } from "@effect-blockchain/evm/EvmAddress"
import type { EvmFeeHistory } from "@effect-blockchain/evm/EvmFeeHistory"
import { EvmHexData } from "@effect-blockchain/evm/EvmHexData"
import * as EvmRelayer from "@effect-blockchain/evm/EvmRelayer"
import * as EvmRpc from "@effect-blockchain/evm/EvmRpc"
import * as EvmSigner from "@effect-blockchain/evm/EvmSigner"
import { EvmTransaction, EvmTransactionReceipt } from "@effect-blockchain/evm/EvmTransaction"
import { EvmTransactionHash } from "@effect-blockchain/evm/EvmTransactionHash"
import { describe, expect, it } from "@effect/vitest"
import * as Config from "effect/Config"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as TestClock from "effect/testing/TestClock"
import { keccak256, parseTransaction } from "viem"

const HASH = EvmTransactionHash.make("0x" + "cd".repeat(32))
const ADDRESS = "0x" + "11".repeat(20)

const TO = Schema.decodeSync(EvmAddress)("0x" + "22".repeat(20))
// Anvil's first well-known key
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
const SIGNED = EvmHexData.make("0x02ab")

// the error of a single endpoint whose node answered a JSON-RPC error
const rejected = (message: string) =>
  new EvmRpc.EvmRpcError({
    reason: new JsonRpc.Rejected(),
    method: "eth_sendRawTransaction",
    endpoint: "a",
    code: -32000,
    cause: new Error(message)
  })

const pending = Schema.decodeUnknownSync(EvmTransaction)({
  hash: HASH,
  from: ADDRESS,
  to: ADDRESS,
  nonce: "0x0",
  value: "0x0",
  input: "0x",
  gas: "0x5208",
  blockNumber: null,
  blockHash: null,
  transactionIndex: null
})

const receipt = (block: number, status = 1) =>
  Schema.decodeUnknownSync(EvmTransactionReceipt)({
    transactionHash: HASH,
    transactionIndex: "0x0",
    blockNumber: `0x${block.toString(16)}`,
    blockHash: "0x" + "ab".repeat(32),
    from: ADDRESS,
    to: ADDRESS,
    status: `0x${status}`,
    gasUsed: "0x5208",
    effectiveGasPrice: "0x1",
    logs: []
  })

interface Node {
  readonly head: number
  readonly transaction?: EvmTransaction | undefined
  readonly receipt?: EvmTransactionReceipt | undefined
}

// a fake service answering from `node.current`, which a test replaces between polls
const setup = (
  initial: Node,
  options?: Parameters<typeof EvmRelayer.layer>[0],
  overrides?: Partial<EvmRpc.EvmRpc["Service"]>
) => {
  const node = { current: initial, polls: 0 }
  const rpc = Layer.succeed(
    EvmRpc.EvmRpc,
    EvmRpc.EvmRpc.of({
      network: "Ethereum",
      chainId: Effect.die("unused"),
      blockNumber: Effect.sync(() => BigInt(node.current.head)),
      getBlockByNumber: () => Effect.die("unused"),
      getBalance: () => Effect.die("unused"),
      getLogs: () => Effect.die("unused"),
      getTransactionByHash: () => Effect.sync(() => node.current.transaction ?? null),
      getTransactionReceipt: () =>
        Effect.sync(() => {
          node.polls++
          return node.current.receipt ?? null
        }),
      sendRawTransaction: () => Effect.die("unused"),
      getTransactionCount: () => Effect.die("unused"),
      estimateGas: () => Effect.die("unused"),
      call: () => Effect.die("unused"),
      feeHistory: () => Effect.die("unused"),
      ...overrides
    })
  )
  const run = <A, E>(f: (relayer: EvmRelayer.EvmRelayer["Service"]) => Effect.Effect<A, E>) =>
    Effect.gen(function*() {
      return yield* f(yield* EvmRelayer.EvmRelayer)
    }).pipe(Effect.provide(EvmRelayer.layer(options).pipe(Layer.provide(rpc))))
  return { node, run }
}

const statusOf = (node: Node, options?: Parameters<typeof EvmRelayer.layer>[0]) =>
  setup(node, options).run((relayer) => relayer.fetchTransactionStatus({ hash: HASH }))

describe("EvmRelayer", () => {
  it.effect("maps what the node knows to a status", () =>
    Effect.gen(function*() {
      // Ethereum confirms after 64 blocks: head 164 confirms block 100
      expect(yield* statusOf({ head: 164 })).toStrictEqual({ _tag: "NotFound" })
      expect(yield* statusOf({ head: 164, transaction: pending })).toStrictEqual({ _tag: "Pending" })
      expect(yield* statusOf({ head: 163, receipt: receipt(100) })).toStrictEqual({
        _tag: "Included",
        block: BigInt(100)
      })
      expect(yield* statusOf({ head: 164, receipt: receipt(100) })).toStrictEqual({
        _tag: "Confirmed",
        block: BigInt(100)
      })
    }))

  it.effect("reports a revert as Failed only once its block is confirmed", () =>
    Effect.gen(function*() {
      expect(yield* statusOf({ head: 163, receipt: receipt(100, 0) })).toStrictEqual({
        _tag: "Included",
        block: BigInt(100)
      })
      expect(yield* statusOf({ head: 164, receipt: receipt(100, 0) })).toStrictEqual({
        _tag: "Failed",
        block: BigInt(100),
        reason: undefined
      })
    }))

  it.effect("uses the confirmations option", () =>
    Effect.gen(function*() {
      expect((yield* statusOf({ head: 101, receipt: receipt(100) }, { confirmations: 2 }))._tag).toBe("Included")
      expect((yield* statusOf({ head: 102, receipt: receipt(100) }, { confirmations: 2 }))._tag).toBe("Confirmed")
    }))

  it.effect("awaitConfirmation polls every 10 seconds until the transaction is confirmed", () => {
    const { node, run } = setup({ head: 100 })
    return run((relayer) =>
      Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(relayer.awaitConfirmation({ hash: HASH }))
        yield* TestClock.adjust(0)
        expect(node.polls).toBe(1)
        node.current = { head: 100, transaction: pending }
        yield* TestClock.adjust("9 seconds")
        expect(node.polls).toBe(1)
        yield* TestClock.adjust("1 second")
        expect(node.polls).toBe(2)
        node.current = { head: 101, receipt: receipt(101) }
        yield* TestClock.adjust("10 seconds")
        expect(node.polls).toBe(3)
        expect(fiber.pollUnsafe()).toBeUndefined()
        node.current = { head: 165, receipt: receipt(101) }
        yield* TestClock.adjust("10 seconds")
        expect(yield* Fiber.join(fiber)).toStrictEqual({ _tag: "Confirmed", block: BigInt(101) })
        expect(node.polls).toBe(4)
      })
    )
  })

  it.effect("awaitConfirmation returns a confirmed revert, and the last status when poll ends first", () =>
    Effect.gen(function*() {
      const failed = setup({ head: 164, receipt: receipt(100, 0) })
      expect((yield* failed.run((relayer) => relayer.awaitConfirmation({ hash: HASH })))._tag).toBe("Failed")
      expect(failed.node.polls).toBe(1)
      const unknown = setup({ head: 164 })
      expect(
        yield* unknown.run((relayer) => relayer.awaitConfirmation({ hash: HASH, poll: Schedule.recurs(2) }))
      ).toStrictEqual({ _tag: "NotFound" })
      expect(unknown.node.polls).toBe(3)
    }))

  it("defaultFees takes the median of the 50th percentile rewards and twice the base fee", () => {
    const gwei = (value: number) => BigInt(Math.round(value * 1e9))
    const rewards = [[1, 2, 3], [1, 9, 20], [0, 0, 0], [1, 4, 5], [1, 3, 9]].map((block) => block.map(gwei))
    expect(EvmRelayer.defaultFees({ baseFeePerGas: gwei(10), rewards })).toStrictEqual({
      maxFeePerGas: gwei(23),
      maxPriorityFeePerGas: gwei(3)
    })
    // empty blocks report zero rewards: the floor of 0.001 gwei applies
    expect(EvmRelayer.defaultFees({ baseFeePerGas: gwei(10), rewards: [[0, 0, 0].map(gwei), [0, 0, 0].map(gwei)] }))
      .toStrictEqual({ maxFeePerGas: gwei(20.001), maxPriorityFeePerGas: gwei(0.001) })
    // a node that returns no reward, or one block without the percentiles
    for (const none of [[], [[]]]) {
      expect(EvmRelayer.defaultFees({ baseFeePerGas: gwei(10), rewards: none })).toStrictEqual({
        maxFeePerGas: gwei(20.001),
        maxPriorityFeePerGas: gwei(0.001)
      })
    }
  })

  it.effect("sign reads the pending nonce, a buffered gas estimate and the fee strategy", () =>
    Effect.gen(function*() {
      const signer = yield* EvmSigner.fromPrivateKey({ key: Redacted.make(KEY) })
      const asked: Array<unknown> = []
      // 3 blocks answered for the 10 asked
      const history: EvmFeeHistory = {
        oldestBlock: BigInt(7),
        baseFeePerGas: [BigInt(90), BigInt(100), BigInt(110), BigInt(1_000_000_000)],
        gasUsedRatio: [0.5, 0.5, 0.5],
        reward: [[1, 2, 3], [0, 0, 0], [5, 6, 7]].map((block) => block.map((reward) => BigInt(reward * 1_000_000)))
      }
      const { run } = setup({ head: 100 }, undefined, {
        getTransactionCount: (options) => Effect.sync(() => (asked.push(options), BigInt(7))),
        estimateGas: (options) => Effect.sync(() => (asked.push(options), BigInt(21001))),
        feeHistory: (options) => Effect.sync(() => (asked.push(options), history))
      })
      const { hash, nonce, signed } = yield* run((relayer) => relayer.sign({ signer, to: TO, value: BigInt(5) }))
      expect(asked).toStrictEqual([
        { address: signer.address, blockTag: "pending" },
        { from: signer.address, to: TO, value: BigInt(5), data: undefined },
        { blockCount: 10, newestBlock: "latest", rewardPercentiles: [25, 50, 75] }
      ])
      expect(nonce).toBe(BigInt(7))
      expect(hash).toBe(keccak256(signed))
      expect(parseTransaction(signed)).toMatchObject({
        type: "eip1559",
        chainId: 1,
        nonce: 7,
        to: expect.stringMatching(new RegExp(TO, "i")),
        value: BigInt(5),
        gas: BigInt(25201),
        maxFeePerGas: BigInt(2_002_000_000),
        maxPriorityFeePerGas: BigInt(2_000_000)
      })
    }))

  it.effect("sign uses the layer's fee strategy and gas multiplier, and a history without rewards", () =>
    Effect.gen(function*() {
      const signer = yield* EvmSigner.fromPrivateKey({ key: Redacted.make(KEY) })
      const estimates: Array<EvmRelayer.EvmFeeEstimate> = []
      const { run } = setup({ head: 100 }, {
        gasMultiplier: 2,
        fees: (estimate) => {
          estimates.push(estimate)
          return { maxFeePerGas: BigInt(50), maxPriorityFeePerGas: BigInt(3) }
        }
      }, {
        getTransactionCount: () => Effect.succeed(BigInt(0)),
        estimateGas: () => Effect.succeed(BigInt(30000)),
        feeHistory: () => Effect.succeed({ oldestBlock: BigInt(7), baseFeePerGas: [BigInt(9)], gasUsedRatio: [] })
      })
      const { signed } = yield* run((relayer) => relayer.sign({ signer, to: TO, data: EvmHexData.make("0xab") }))
      expect(estimates).toStrictEqual([{ baseFeePerGas: BigInt(9), rewards: [] }])
      expect(parseTransaction(signed)).toMatchObject({
        data: "0xab",
        gas: BigInt(60000),
        maxFeePerGas: BigInt(50),
        maxPriorityFeePerGas: BigInt(3)
      })
    }))

  it.effect("sign reads nothing when the nonce, gas and fees are given, and keeps a failed estimate", () =>
    Effect.gen(function*() {
      const signer = yield* EvmSigner.fromPrivateKey({ key: Redacted.make(KEY) })
      const explicit = {
        signer,
        to: TO,
        nonce: BigInt(3),
        gas: BigInt(21000),
        fees: { maxFeePerGas: BigInt(40), maxPriorityFeePerGas: BigInt(2) }
      }
      const refused = rejected("execution reverted")
      const { run } = setup({ head: 100 }, undefined, { estimateGas: () => Effect.fail(refused) })
      const { nonce, signed } = yield* run((relayer) => relayer.sign(explicit))
      expect(nonce).toBe(BigInt(3))
      expect(parseTransaction(signed)).toMatchObject({
        nonce: 3,
        gas: BigInt(21000),
        maxFeePerGas: BigInt(40),
        maxPriorityFeePerGas: BigInt(2)
      })
      const error = yield* Effect.flip(run((relayer) => relayer.sign({ ...explicit, gas: undefined })))
      expect(error).toMatchObject({
        _tag: "EvmSimulationError",
        reason: { _tag: "SimulationFailed", error: "execution reverted" }
      })
      expect(error.cause).toBe(refused)
    }))

  it.effect("sign keeps a transport failure of the estimate an EvmRpcError", () =>
    Effect.gen(function*() {
      const signer = yield* EvmSigner.fromPrivateKey({ key: Redacted.make(KEY) })
      const unavailable = new EvmRpc.EvmRpcError({
        reason: new JsonRpc.Unavailable({}),
        method: "eth_estimateGas",
        endpoint: "a",
        cause: new Error("Transport")
      })
      const { run } = setup({ head: 100 }, undefined, { estimateGas: () => Effect.fail(unavailable) })
      const error = yield* Effect.flip(run((relayer) =>
        relayer.sign({
          signer,
          to: TO,
          nonce: BigInt(3),
          fees: { maxFeePerGas: BigInt(40), maxPriorityFeePerGas: BigInt(2) }
        })
      ))
      expect(error).toBe(unavailable)
    }))

  it.effect("layerConfig reads the confirmations from config", () =>
    Effect.gen(function*() {
      const rpc = Layer.mock(EvmRpc.EvmRpc)({
        network: "Ethereum",
        blockNumber: Effect.succeed(BigInt(100)),
        getTransactionReceipt: () => Effect.succeed(receipt(95))
      })
      const status = (env: Record<string, string>) =>
        Effect.gen(function*() {
          return yield* (yield* EvmRelayer.EvmRelayer).fetchTransactionStatus({ hash: HASH })
        }).pipe(
          Effect.provide(
            EvmRelayer.layerConfig({ confirmations: Config.Int("ETHEREUM_CONFIRMATIONS") }).pipe(
              Layer.provide(rpc),
              Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env)))
            )
          )
        )
      expect(yield* status({ ETHEREUM_CONFIRMATIONS: "5" })).toStrictEqual({ _tag: "Confirmed", block: BigInt(95) })
      expect(yield* status({ ETHEREUM_CONFIRMATIONS: "6" })).toStrictEqual({ _tag: "Included", block: BigInt(95) })
      expect(yield* Effect.flip(status({}))).toMatchObject({ _tag: "ConfigError" })
    }))

  it.effect("broadcast returns the node's hash", () =>
    Effect.gen(function*() {
      const sent: Array<EvmHexData> = []
      const { run } = setup({ head: 100 }, undefined, {
        sendRawTransaction: ({ signed }) => Effect.sync(() => (sent.push(signed), HASH))
      })
      expect(yield* run((relayer) => relayer.broadcast({ signed: SIGNED }))).toBe(HASH)
      expect(sent).toStrictEqual([SIGNED])
    }))

  it.effect("broadcast succeeds when a node already has the transaction", () =>
    Effect.gen(function*() {
      const messages = [
        "already known",
        "AlreadyKnown",
        "Known transaction",
        "transaction already imported",
        "Transaction with the same hash was already imported."
      ]
      for (const message of messages) {
        const { run } = setup({ head: 100 }, undefined, { sendRawTransaction: () => Effect.fail(rejected(message)) })
        expect(yield* run((relayer) => relayer.broadcast({ signed: SIGNED }))).toBe(keccak256(SIGNED))
      }
      // the first endpoint timed out after taking the transaction, the second refuses its copy
      const fallback = new EvmRpc.EvmRpcError({
        reason: new JsonRpc.Rejected(),
        method: "eth_sendRawTransaction",
        endpoint: "b",
        cause: new AggregateError([
          new EvmRpc.EvmRpcError({
            reason: new JsonRpc.Unavailable(),
            method: "eth_sendRawTransaction",
            endpoint: "a",
            cause: new Error("timed out")
          }),
          rejected("already known")
        ])
      })
      const { run } = setup({ head: 100 }, undefined, { sendRawTransaction: () => Effect.fail(fallback) })
      expect(yield* run((relayer) => relayer.broadcast({ signed: SIGNED }))).toBe(keccak256(SIGNED))
    }))

  it.effect("broadcast succeeds on a used nonce when the node knows the transaction", () =>
    Effect.gen(function*() {
      const looked: Array<EvmTransactionHash> = []
      const { node, run } = setup({ head: 100, transaction: pending }, undefined, {
        sendRawTransaction: () => Effect.fail(rejected("nonce too low: next nonce 8, tx nonce 7")),
        getTransactionByHash: ({ hash }) => Effect.sync(() => (looked.push(hash), node.current.transaction ?? null))
      })
      expect(yield* run((relayer) => relayer.broadcast({ signed: SIGNED }))).toBe(keccak256(SIGNED))
      node.current = { head: 100 }
      const error = yield* Effect.flip(run((relayer) => relayer.broadcast({ signed: SIGNED })))
      expect(error).toMatchObject({ _tag: "EvmBroadcastError", reason: { _tag: "InvalidNonce" } })
      expect(looked).toStrictEqual([keccak256(SIGNED), keccak256(SIGNED)])
    }))

  it.effect("broadcast maps a node's refusal to a reason and keeps its error as the cause", () =>
    Effect.gen(function*() {
      const refusals = {
        "OldNonce": "InvalidNonce",
        "replacement transaction underpriced": "ReplacementUnderpriced",
        "ReplacementNotAllowed": "ReplacementUnderpriced",
        "insufficient funds for gas * price + value: balance 0, tx cost 21000": "InsufficientFunds",
        "Insufficient funds. The account you tried to send transaction from does not have enough funds.":
          "InsufficientFunds",
        "Upfront cost exceeds transaction sender account balance": "InsufficientFunds",
        "transaction underpriced": "FeeTooLow",
        "max fee per gas less than block base fee": "FeeTooLow",
        "FeeTooLow": "FeeTooLow",
        "Gas price below configured minimum gas price": "FeeTooLow"
      }
      for (const [message, reason] of Object.entries(refusals)) {
        const cause = rejected(message)
        const { run } = setup({ head: 100 }, undefined, { sendRawTransaction: () => Effect.fail(cause) })
        const error = yield* Effect.flip(run((relayer) => relayer.broadcast({ signed: SIGNED })))
        expect(error).toMatchObject({ _tag: "EvmBroadcastError", reason: { _tag: reason } })
        expect(error.cause).toBe(cause)
      }
      const matched = setup({ head: 100 }, undefined, {
        sendRawTransaction: () => Effect.fail(rejected("replacement transaction underpriced"))
      }).run((relayer) =>
        relayer.broadcast({ signed: SIGNED }).pipe(
          Effect.catchReason("EvmBroadcastError", "ReplacementUnderpriced", () => Effect.succeed("bump"))
        )
      )
      expect(yield* matched).toBe("bump")
    }))

  it.effect("broadcast keeps any other failure as an EvmRpcError", () =>
    Effect.gen(function*() {
      const causes = [
        rejected("intrinsic gas too low"),
        new EvmRpc.EvmRpcError({
          reason: new JsonRpc.Unavailable(),
          method: "eth_sendRawTransaction",
          endpoint: "a",
          cause: "timed out"
        })
      ]
      for (const cause of causes) {
        const { run } = setup({ head: 100 }, undefined, { sendRawTransaction: () => Effect.fail(cause) })
        expect(yield* Effect.flip(run((relayer) => relayer.broadcast({ signed: SIGNED })))).toBe(cause)
      }
    }))

  // the pinned transactions of `scripts/record-fixtures.ts`, both in block 26083549, far below the recorded head
  for (const provider of ["alchemy", "infura"]) {
    it.effect(`fixture: ${provider} status of a confirmed and of a reverted transaction`, () => {
      const { check, endpoints, fetch, served } = Replay.replay(new URL("fixtures/", import.meta.url), [{
        name: provider,
        cases: ["chainId", "blockNumber", "getTransactionReceipt", "getTransactionReceipt-reverted"]
      }])
      const layer = EvmRelayer.layer().pipe(
        Layer.provide(EvmRpc.layer({ network: "Ethereum", endpoints, retries: 0 })),
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))
      )
      return check(
        Effect.gen(function*() {
          const relayer = yield* EvmRelayer.EvmRelayer
          expect(
            yield* relayer.fetchTransactionStatus({
              hash: EvmTransactionHash.make("0x5b742dac0f3747de0d0196a04c4d821c8e086f06c4b98d024b08ae18ea39678e")
            })
          ).toStrictEqual({ _tag: "Confirmed", block: BigInt(26083549) })
          expect(
            yield* relayer.fetchTransactionStatus({
              hash: EvmTransactionHash.make("0x94bb947f04a680590b0c639820e7c7552521a26b2fa424824984be66e5bcc39c")
            })
          ).toStrictEqual({ _tag: "Failed", block: BigInt(26083549), reason: undefined })
          expect(served).toStrictEqual([
            `${provider} chainId`,
            `${provider} getTransactionReceipt`,
            `${provider} blockNumber`,
            `${provider} getTransactionReceipt-reverted`,
            `${provider} blockNumber`
          ])
        }).pipe(Effect.provide(layer))
      )
    })
  }
})
