import type { RpcJson } from "./rpcMethods.ts"

const integer = /^-?\d+$/

/**
 * Parses JSON with every integer literal as an exact `bigint`, like `@solana/kit` does: u64 values above 2^53 are
 * never rounded. Reads the literal's source text through the reviver's third argument (Node >= 24).
 *
 * @internal
 */
export const parse = (text: string): RpcJson =>
  JSON.parse(
    text,
    (_key, value: RpcJson, context?: { readonly source?: string }) =>
      typeof value === "number" && context?.source !== undefined && integer.test(context.source)
        ? BigInt(context.source)
        : value
  )
