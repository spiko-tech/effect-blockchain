const REDACTED_PATH = "/[REDACTED]"

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const redactValue = (value: unknown, pattern: RegExp, replacement: string): unknown => {
  if (typeof value === "string") return value.replace(pattern, replacement)
  if (Array.isArray(value)) return value.map((item) => redactValue(item, pattern, replacement))
  return value
}

// viem writes the full RPC URL into its errors and only strips basic-auth credentials,
// while providers usually carry their API key in the URL path or query
/** @internal */
export const redactRpcUrl = (error: unknown, url: string): unknown => {
  if (!(error instanceof Error) || !URL.canParse(url)) return error
  const { origin } = new URL(url)
  // the raw URL first: with basic-auth credentials it does not start with the origin
  const pattern = new RegExp(`${escapeRegExp(url)}|${escapeRegExp(origin)}\\S*`, "g")
  const replacement = `${origin}${REDACTED_PATH}`
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    for (const key of Object.getOwnPropertyNames(current)) {
      Reflect.set(current, key, redactValue(Reflect.get(current, key), pattern, replacement))
    }
  }
  return error
}
