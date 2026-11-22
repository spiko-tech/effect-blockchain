---
title: Concepts
permalink: /concepts
nav_order: 7
---

# Concepts

The four chain packages (`evm`, `starknet`, `solana`, `stellar`) share the rules on this page. Each module documents
what is specific to its chain.

## Endpoint fallback

A `<Chain>Rpc` layer takes an ordered list of endpoints. A call starts at the first endpoint and moves to the next one
when it fails. Each endpoint is checked once to serve the configured network, and an endpoint serving another network
fails the call with `WrongNetwork` without falling back.

Every failure is a `<Chain>RpcError` with a `reason`, matched with `Effect.catchReason`. The reasons are the
[`JsonRpc.Reason`](https://github.com/spiko-tech/effect-blockchain/blob/main/packages/core/src/JsonRpc.ts) union:

| reason            | meaning                                                                   | retried on the same endpoint |
| ----------------- | ------------------------------------------------------------------------- | ---------------------------- |
| `Unavailable`     | transport error, timeout, HTTP error status or a code the chain maps here | yes, except a timeout        |
| `InvalidResponse` | the reply is not JSON or fails its schema                                 | no                           |
| `Lagging`         | the endpoint is behind the requested block                                | no                           |
| `Pruned`          | the endpoint lacks the requested history                                  | no                           |
| `Rejected`        | any other JSON-RPC error, or params that do not encode                    | no                           |
| `WrongNetwork`    | the endpoint does not serve the configured network                        | no                           |

After the last endpoint, the error is the last endpoint's error and its `cause` is an `AggregateError` holding the
error of each endpoint in order. `code` is the JSON-RPC error code or the HTTP status. The `name` of an endpoint
appears in errors, spans and metrics. Its `url` is `Redacted` and never does.

`JsonRpc.isTransient(reason)` is `true` for `Unavailable`, `InvalidResponse` and `Lagging`: a later attempt can
succeed. The other reasons answer the same at the same block.

A paging cursor (`getEvents` on Starknet and Stellar, `getLedgers` on Stellar) records the name of the endpoint that
issued it, and the next page is only sent to that endpoint, with no fallback. The first endpoint with that name
receives it, so give each endpoint its own name.

## Archive endpoints on Stellar

A Stellar RPC node retains about 7 days of ledgers by default, and less on some providers. An endpoint configured with
`archive: true` serves the whole history. It takes every call like the other endpoints, and it is the only kind that
takes a `getLedgers` call asking for `archive`. Without an archive endpoint, a read below the retention window fails
with `Pruned`.

A past native balance is read from the account entry at the head, then back through the ledger of each change since.
An account missing at the head reads `0` at every past ledger, so a merged account reads `0` before its merge, and a
merged then recreated account reads `0` before its re-creation.

## Indexer streams

A stream reads confirmed blocks from `fromBlock` on and follows the confirmed head.

- `toBlock` ends the stream after the batch or sample that reaches it. The stream is empty when `fromBlock > toBlock`.
- `poll` decides when to read the head again once the stream has caught up. It defaults to
  `Schedule.spaced(DEFAULT_POLL_INTERVAL)` (10 seconds), restarts after each batch, and its end ends the stream:
  `Schedule.recurs(0)` drains to the head and stops.
- `retry` retries a step that failed with a transient reason at the same position. It is off by default.

Delivery is at-least-once: save `batch.toBlock` once the batch is handled and resume from `toBlock + 1`.

## History reads

A history read costs requests in proportion to the changes of its subject or to its results, and never to the number of
blocks between the requested block and the head. Each history method states its request cost.

Every indexer read (`fetch*` and `stream*`) takes `retry`, which retries each request that failed with a transient
reason. It is off by default.

## Stateless relayer

A `<Chain>Relayer` sends an account's own transactions and manages their nonces and fees, in the sense of
[OpenZeppelin Relayer](https://docs.openzeppelin.com/relayer). It does not pay for another account's transaction
(meta-transactions, paymasters). It keeps no state: the application stores hashes and nonces, decides when to resend
and holds the keys.

`sign` reads the next nonce or sequence number from the node when none is given. Two concurrent `sign` calls for one
account read the same value, so senders sharing an account pass their own.

## Store the hash, then broadcast

`sign` returns the transaction hash without sending anything. Store the hash, with the nonce or expiry returned next
to it, before calling `broadcast`: after a crash between the two, the application has a hash to look up.

`broadcast` is idempotent. Sending the same signed transaction again returns the same hash, including when the node
answers that it already holds the transaction or has it in a block.

## Transaction status

`fetchTransactionStatus` answers with one status, as the answering endpoint sees the transaction:

| status      | meaning                                                             | final |
| ----------- | ------------------------------------------------------------------- | ----- |
| `Pending`   | known to the node, not in a block                                   | no    |
| `Included`  | in `block`, above the last confirmed block                          | no    |
| `Confirmed` | succeeded in `block`, at or below the last confirmed block          | yes   |
| `Failed`    | failed in `block`, at or below the last confirmed block             | yes   |
| `Expired`   | unknown to the node, and past the last block that could hold it     | yes   |
| `NotFound`  | unknown to the node: not propagated yet, dropped, pruned, never sent | no    |

`Expired` exists on Solana and Stellar, where a transaction carries an expiry (`lastValidBlockHeight`, `maxLedger`).
Solana and Stellar nodes do not expose unprocessed transactions, so their relayers never return `Pending`.

`awaitConfirmation` reads the status on `poll` (every 10 seconds by default) until it is final, and reads again after
a transient error. `NotFound` keeps polling, so bound the wait with `Effect.timeout`.

## Confirmations and finality

The last confirmed block is the head minus `confirmations`. The Relayer and the Indexer of a chain take the same
`confirmations` option and default, so they agree on it.

| chain    | head                         | default `confirmations`                                        |
| -------- | ---------------------------- | -------------------------------------------------------------- |
| EVM      | latest block                 | per network, see `EvmNetwork.defaultConfirmations`             |
| Starknet | latest block accepted on L2  | 0                                                              |
| Solana   | latest `finalized` slot      | 0                                                              |
| Stellar  | latest closed ledger         | 0, a closed ledger is never reverted                           |

On Solana, the `Confirmed` status means finalized. A block at the `confirmed` commitment is `Included`.

## Signers

A `<Chain>Signer` receives the whole transaction and returns its signature. `fromPrivateKey` signs with a key held in
memory. `fromHashSigner` adapts a key held elsewhere (a custody API, an HSM) that only signs a hash: the adapter
computes the hash from the transaction, so the caller never chooses the hash that gets signed, and it checks the
returned signature against the signer's address where the chain allows it. Solana signs the message bytes without
hashing them, so its adapter is `fromMessageSigner`.

Errors never contain a private key.
