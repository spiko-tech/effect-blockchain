import * as Schema from "effect/Schema"
import { constants, EDAMode, hash } from "starknet"
import { StarknetAddress } from "../StarknetAddress.ts"
import type { StarknetDeployAccountTransaction, StarknetInvokeTransaction } from "../StarknetTransaction.ts"
import { StarknetTransactionHash } from "../StarknetTransactionHash.ts"

/**
 * The address a `DEPLOY_ACCOUNT` transaction deploys to. Throws on a value that is not a felt.
 *
 * @internal
 */
export const deployAddress = (
  transaction: Pick<StarknetDeployAccountTransaction, "classHash" | "contractAddressSalt" | "constructorCalldata">
): StarknetAddress =>
  Schema.decodeSync(StarknetAddress)(
    // an account deploys itself: the deployer address is 0
    hash.calculateContractAddressFromHash(
      transaction.contractAddressSalt,
      transaction.classHash,
      [...transaction.constructorCalldata],
      0
    )
  )

/**
 * The V3 transaction hash (Poseidon), which is what an account signs. Throws on a value that is not a felt.
 *
 * @internal
 */
export const transactionHash = (
  transaction: Omit<StarknetInvokeTransaction, "signature"> | Omit<StarknetDeployAccountTransaction, "signature">
): StarknetTransactionHash => {
  const { l1DataGas, l1Gas, l2Gas } = transaction.resourceBounds
  const common = {
    version: "0x3" as const,
    chainId: constants.StarknetChainId[transaction.chainId],
    nonce: transaction.nonce,
    nonceDataAvailabilityMode: EDAMode.L1,
    feeDataAvailabilityMode: EDAMode.L1,
    resourceBounds: {
      l1_gas: { max_amount: l1Gas.maxAmount, max_price_per_unit: l1Gas.maxPricePerUnit },
      l2_gas: { max_amount: l2Gas.maxAmount, max_price_per_unit: l2Gas.maxPricePerUnit },
      l1_data_gas: { max_amount: l1DataGas.maxAmount, max_price_per_unit: l1DataGas.maxPricePerUnit }
    },
    tip: transaction.tip,
    paymasterData: []
  }
  return Schema.decodeSync(StarknetTransactionHash)(
    transaction.type === "INVOKE"
      ? hash.calculateInvokeTransactionHash({
        ...common,
        senderAddress: transaction.senderAddress,
        compiledCalldata: [...transaction.calldata],
        accountDeploymentData: []
      })
      : hash.calculateDeployAccountTransactionHash({
        ...common,
        contractAddress: deployAddress(transaction),
        classHash: transaction.classHash,
        compiledConstructorCalldata: [...transaction.constructorCalldata],
        salt: transaction.contractAddressSalt
      })
  )
}
