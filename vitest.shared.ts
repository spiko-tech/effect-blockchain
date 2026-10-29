import * as path from "node:path"
import type { ViteUserConfig } from "vitest/config"

const alias = (pkg: string, dir = pkg) => {
  const name = `@effect-blockchain/${pkg}`
  const target = process.env.TEST_DIST !== undefined ? "dist" : "src"
  return ({
    [`${name}/test`]: path.join(import.meta.dirname, "packages", dir, "test"),
    [`${name}`]: path.join(import.meta.dirname, "packages", dir, target)
  })
}

const config: ViteUserConfig = {
  oxc: {
    target: "es2020"
  },
  test: {
    setupFiles: [path.join(import.meta.dirname, "vitest.setup.ts")],
    sequence: {
      concurrent: true
    },
    hookTimeout: 20000,
    include: ["test/**/*.test.ts"],
    alias: {
      ...alias("evm"),
      ...alias("solana"),
      ...alias("starknet"),
      ...alias("stellar")
    }
  }
}

export default config
