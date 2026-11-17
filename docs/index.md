---
title: Introduction
permalink: /
nav_order: 1
has_children: false
has_toc: false
---

# effect-blockchain

Effect toolkit for EVM, Starknet, Solana and Stellar. Each chain package has the same four modules:

| module           | purpose                                                                       |
| ---------------- | ----------------------------------------------------------------------------- |
| `<Chain>Rpc`     | the chain's RPC methods over an ordered list of endpoints with fallback       |
| `<Chain>Indexer` | logs, events, transactions and native balances over confirmed blocks          |
| `<Chain>Relayer` | signs and broadcasts a transaction, then follows it until it is final         |
| `<Chain>Signer`  | signs with a key in memory, or adapts a custody API that signs a hash         |

Read [Concepts](./concepts.md) for the rules the four chains share, then the modules of each package in the
navigation.
