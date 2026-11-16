/**
 * The Starknet V3 transactions an account sends: an `INVOKE` of its `__execute__` entrypoint and the `DEPLOY_ACCOUNT`
 * of its own contract.
 *
 * Fees are paid in STRK. Nonce and fee data availability modes are `L1`, and paymaster and account deployment data
 * are empty: these are the only values the protocol accepts. Felts are 0x-prefixed hexadecimal strings.
 *
 * @since 0.2.0
 */
import type { StarknetAddress } from "./StarknetAddress.ts"
import type { StarknetChainId } from "./StarknetNetwork.ts"

/**
 * The most a V3 transaction pays for each resource: `maxAmount` units at `maxPricePerUnit` FRI (10^-18 STRK) at most.
 *
 * @since 0.2.0
 * @category models
 */
export interface StarknetResourceBounds {
  readonly l1Gas: { readonly maxAmount: bigint; readonly maxPricePerUnit: bigint }
  readonly l1DataGas: { readonly maxAmount: bigint; readonly maxPricePerUnit: bigint }
  readonly l2Gas: { readonly maxAmount: bigint; readonly maxPricePerUnit: bigint }
}

/**
 * An `INVOKE` V3 transaction: `calldata` is the calldata of the `__execute__` entrypoint of `senderAddress`, and
 * `signature` the felts its `__validate__` entrypoint checks.
 *
 * @since 0.2.0
 * @category models
 */
export interface StarknetInvokeTransaction {
  readonly type: "INVOKE"
  readonly chainId: StarknetChainId
  readonly senderAddress: StarknetAddress
  readonly calldata: ReadonlyArray<string>
  readonly nonce: bigint
  readonly resourceBounds: StarknetResourceBounds
  readonly tip: bigint
  readonly signature: ReadonlyArray<string>
}

/**
 * A `DEPLOY_ACCOUNT` V3 transaction: deploys the account contract of class `classHash` at the address its class hash,
 * salt and constructor calldata determine. That address pays the fee, so it holds STRK before the deployment.
 *
 * @since 0.2.0
 * @category models
 */
export interface StarknetDeployAccountTransaction {
  readonly type: "DEPLOY_ACCOUNT"
  readonly chainId: StarknetChainId
  readonly classHash: string
  readonly contractAddressSalt: string
  readonly constructorCalldata: ReadonlyArray<string>
  readonly nonce: bigint
  readonly resourceBounds: StarknetResourceBounds
  readonly tip: bigint
  readonly signature: ReadonlyArray<string>
}

/**
 * A signed transaction, as `starknet_addInvokeTransaction` and `starknet_addDeployAccountTransaction` take it.
 *
 * @since 0.2.0
 * @category models
 */
export type StarknetTransaction = StarknetInvokeTransaction | StarknetDeployAccountTransaction
