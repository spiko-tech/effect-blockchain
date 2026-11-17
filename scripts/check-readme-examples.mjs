// Fails when a `ts` code block of a README is not, verbatim, an `@example` of a module: `pnpm docgen` type-checks
// the `@example` blocks, so a README sample that matches one is known to compile.
import { globSync, readFileSync } from "node:fs"

const examples = new Set(
  globSync("packages/*/src/**/*.ts").flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(/@example\n(?:\s*\* ?)```ts\n([\s\S]*?)\n\s*\* ?```/g)].map(([, body]) =>
      body.replace(/^\s*\* ?/gm, "")
    )
  )
)

const stale = globSync(["README.md", "packages/*/README.md"]).flatMap((file) =>
  [...readFileSync(file, "utf8").matchAll(/```ts\n([\s\S]*?)\n```/g)]
    .filter(([, body]) => !examples.has(body))
    .map(([, body]) => `${file}: ${body.split("\n")[0]}`)
)

if (stale.length > 0) {
  console.error(`README code blocks that match no @example:\n${stale.join("\n")}`)
  process.exit(1)
}
