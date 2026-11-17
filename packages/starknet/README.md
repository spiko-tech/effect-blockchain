# `@effect-blockchain/starknet`

Starknet blockchain toolkit for Effect.

## Installation

```bash
pnpm add @effect-blockchain/starknet effect starknet
```

`starknet` is an optional peer dependency: only `StarknetRelayer` and `StarknetSigner` need it. Without it, install `@effect-blockchain/starknet effect` and import the other modules by subpath (`@effect-blockchain/starknet/StarknetRpc`, `@effect-blockchain/starknet/StarknetIndexer`), since the package root re-exports the Relayer and the Signer.

## License

MIT
