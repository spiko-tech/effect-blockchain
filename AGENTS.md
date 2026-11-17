# Agent Guidelines for effect-blockchain

## Learning more about Effect

This repository uses the Effect TypeScript library.
Before writing any Effect code, read `node_modules/effect/AGENTS.md` completely and follow its links when needed.
For concepts not covered by that guide, search the source in `node_modules/effect/src`.

## Commands

- Build: `pnpm build`
- Test: `pnpm test` (single test: `pnpm test path/to/test.test.ts`)
- Lint: `pnpm lint` (fix: `pnpm lint-fix`)
- Type check: `pnpm check`
- Coverage: `pnpm coverage`

## Code Style

- Use Effect ecosystem libraries (effect, @effect/platform, @effect/vitest)
- Import style: `import type * as X from "module"` for types, regular imports for values
- No semicolons, no trailing commas
- 2-space indentation, 120 char line width
- Double quotes for strings
- Use `@since` JSDoc tags for new APIs
- Prefix unused variables with underscore
- Use generic array types: `Array<T>` not `T[]`

## Testing

- Run `pnpm build` and `pnpm lint` before testing
- Use @effect/vitest for testing utilities
- Test files in `test/` directories with `.test.ts` extension

## Changesets

- Always run `pnpm changeset` after changes
- Use patch for dependency updates/bug fixes
- Include specific version numbers in summaries

## Comments and docs

- A module header is 1-3 sentences of purpose, plus at most one `@example`. Rules shared by the chains live in `docs/concepts.md`: link to it instead of repeating them.
- A comment gives the reason the code cannot show: a protocol rule, a spec link, a provider quirk with its version, an invariant.
- The first JSDoc sentence is a present-tense summary. Then come defaults, units and failure reasons. Never restate the type.
- Every code sample is an `@example`, so that `pnpm docgen` type-checks it. README samples are copies of an `@example` (`scripts/check-readme-examples.mjs`).
- State the scope in one line. Do not argue for the design or list what a module is not.
- Cite specs and upstream source, not help pages.
- Use one term and one sentence template per concept on every chain.
- Write full sentences, wrapped at 120 columns, without em dashes.
