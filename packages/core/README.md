# `@effect-blockchain/core`

The shared JSON-RPC engine of the `@effect-blockchain` chain packages (`evm`, `solana`, `starknet`, `stellar`). Import it for the reasons every chain error carries (`Unavailable`, `InvalidResponse`, `Lagging`, `Pruned`, `Rejected`, `WrongNetwork`), `isTransient` and the RPC metrics.

```ts
import * as JsonRpc from "@effect-blockchain/core/JsonRpc"
import * as Effect from "effect/Effect"

// retry a chain call only when a later attempt can succeed
const retried = call.pipe(Effect.retry({ times: 3, while: (error) => JsonRpc.isTransient(error.reason) }))
```

The engine itself (`JsonRpc.make` and its types) is internal to the chain packages and can change in any release.

## License

MIT
