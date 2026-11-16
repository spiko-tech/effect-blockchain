import { StarknetAddress } from "@effect-blockchain/starknet/StarknetAddress"
import * as StarknetSigner from "@effect-blockchain/starknet/StarknetSigner"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"

// the first predeployed account of `starknet-devnet --seed 0`: a public key, never funded on a real network
const KEY = "0x71d7bb07b9a64f6f78ac4c816aff4da9"
const PUBLIC_KEY = "0x39d9e6ce352ad4530a0ef5d5a18fd3303c3606a7fa6ac5b620020ad681cc33b"
const ADDRESS = StarknetAddress.make("0x064b48806902a367c8598f4f95c305e8c1a1acba5f082d294a43793113115691")

const common = {
  chainId: "SN_SEPOLIA",
  resourceBounds: {
    l1Gas: { maxAmount: BigInt(100), maxPricePerUnit: BigInt(200) },
    l2Gas: { maxAmount: BigInt(300), maxPricePerUnit: BigInt(400) },
    l1DataGas: { maxAmount: BigInt(500), maxPricePerUnit: BigInt(600) }
  },
  tip: BigInt(9)
} as const

// one call, `transfer(0x2, 1000)` on the STRK token, as `transaction.getExecuteCalldata` of starknet 8.9.2 compiles it
// for a Cairo 1 account
const invoke: StarknetSigner.StarknetUnsignedTransaction = {
  ...common,
  type: "INVOKE",
  senderAddress: ADDRESS,
  calldata: [
    "0x1",
    "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
    "0x0083afd3f4caedc6eebf44246fe54e38c95e3179a5ec9ea81740eca5b482d12e",
    "0x3",
    "0x2",
    "0x3e8",
    "0x0"
  ],
  nonce: BigInt(7)
}
// starknet 8.9.2: `new Signer(KEY).signTransaction` of `invoke`
const INVOKE_SIGNATURE = [
  "0x7b7ec9b746214be9796e1667256750e8ba6efab16373cec3dfa1f3a06606804",
  "0x4e9b79e0d90903e018636c3ce361df573302339ea3c21938e0b75d82496b038"
]

const deployAccount: StarknetSigner.StarknetUnsignedTransaction = {
  ...common,
  type: "DEPLOY_ACCOUNT",
  classHash: "0x05b4b537eaa2399e3aa99c4e2e0208ebd6c71bc1467938cd52c798c601e43564",
  contractAddressSalt: PUBLIC_KEY,
  constructorCalldata: [PUBLIC_KEY],
  nonce: BigInt(0)
}
// starknet 8.9.2: `new Signer(KEY).signDeployAccountTransaction` of `deployAccount`, at the address
// `hash.calculateContractAddressFromHash` gives
const DEPLOY_ACCOUNT_SIGNATURE = [
  "0x7a1f22d794230ea0ec658b0f789b5f489c21e14623a01a4a018c4e52928138d",
  "0x316de9cb40f6c38fb44046c49e385fdc79e13bcfeaa817079316fecd6349fbd"
]

describe("StarknetSigner", () => {
  it.effect("fromPrivateKey signs the V3 hash of an INVOKE and of a DEPLOY_ACCOUNT", () =>
    Effect.gen(function*() {
      const signer = yield* StarknetSigner.fromPrivateKey({ address: ADDRESS, key: Redacted.make(KEY) })
      expect(signer.address).toBe(ADDRESS)
      expect(yield* signer.signTransaction(invoke)).toStrictEqual(INVOKE_SIGNATURE)
      expect(yield* signer.signTransaction(deployAccount)).toStrictEqual(DEPLOY_ACCOUNT_SIGNATURE)
    }))

  it.effect("fromPrivateKey fails on an invalid key without repeating it", () =>
    Effect.gen(function*() {
      for (const key of ["not a key", "0x0", "0x" + "f".repeat(64)]) {
        const error = yield* Effect.flip(StarknetSigner.fromPrivateKey({ address: ADDRESS, key: Redacted.make(key) }))
        expect(error).toBeInstanceOf(StarknetSigner.StarknetSignerError)
        expect(String(error.cause)).toBe("Error: invalid private key")
      }
    }))

  it.effect("fromHashSigner hands the transaction hash to the callback and returns its felts", () =>
    Effect.gen(function*() {
      const hashes: Array<string> = []
      const signer = StarknetSigner.fromHashSigner({
        address: ADDRESS,
        signHash: (hash) => Effect.sync(() => (hashes.push(hash), ["0x1", "0x2", "0x3"]))
      })
      expect(yield* signer.signTransaction(invoke)).toStrictEqual(["0x1", "0x2", "0x3"])
      yield* signer.signTransaction({ ...invoke, nonce: BigInt(8) })
      yield* signer.signTransaction({ ...invoke, chainId: "SN_MAIN" })
      yield* signer.signTransaction(deployAccount)
      expect(new Set(hashes).size).toBe(4)
    }))

  it.effect("fromHashSigner fails with a StarknetSignerError", () =>
    Effect.gen(function*() {
      const failing = StarknetSigner.fromHashSigner({ address: ADDRESS, signHash: () => Effect.fail("policy refused") })
      expect(yield* Effect.flip(failing.signTransaction(invoke))).toMatchObject({
        _tag: "StarknetSignerError",
        cause: "policy refused"
      })
      const refused = new StarknetSigner.StarknetSignerError({ cause: "offline" })
      const typed = StarknetSigner.fromHashSigner({ address: ADDRESS, signHash: () => Effect.fail(refused) })
      expect(yield* Effect.flip(typed.signTransaction(invoke))).toBe(refused)
      const decimal = StarknetSigner.fromHashSigner({ address: ADDRESS, signHash: () => Effect.succeed(["12", "0x1"]) })
      expect(String((yield* Effect.flip(decimal.signTransaction(invoke))).cause)).toContain("0x-prefixed felts")
      const signer = yield* StarknetSigner.fromPrivateKey({ address: ADDRESS, key: Redacted.make(KEY) })
      const malformed = yield* Effect.flip(signer.signTransaction({ ...invoke, calldata: ["not a felt"] }))
      expect(malformed).toBeInstanceOf(StarknetSigner.StarknetSignerError)
    }))
})
