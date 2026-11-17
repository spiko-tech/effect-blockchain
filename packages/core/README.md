# `@effect-blockchain/core`

The shared JSON-RPC engine of the `@effect-blockchain` chain packages (`evm`, `solana`, `starknet`, `stellar`). Import it for the reasons every chain error carries (`Unavailable`, `InvalidResponse`, `Lagging`, `Pruned`, `Rejected`, `WrongNetwork`), `isTransient` and the RPC metrics.

```ts
import * as JsonRpc from "@effect-blockchain/core/JsonRpc"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

// shaped like the chain errors
class ChainRpcError extends Schema.TaggedError<ChainRpcError>()("ChainRpcError", { reason: JsonRpc.Reason }) {}

declare const getLogs: Effect.Effect<ReadonlyArray<string>, ChainRpcError>

// no endpoint keeps this range: read nothing, any other reason stays a ChainRpcError
const logs = getLogs.pipe(Effect.catchReason("ChainRpcError", "Pruned", () => Effect.succeed([])))
```

The engine itself (`JsonRpc.make` and its types) is internal to the chain packages and can change in any release.

## License

MIT
