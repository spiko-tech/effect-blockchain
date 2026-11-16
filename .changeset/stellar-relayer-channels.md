---
"@effect-blockchain/stellar": minor
---

Channel accounts and sponsored account creation on Stellar.

- `StellarRelayer.sign` takes a `channel`: the transaction uses the channel's sequence number and balance, its operations without a source account act for `signer`, and both sign. Several transactions of one account can then be in flight at once, one per channel. Wrapping the result with `feeBump` makes one funded account pay for every channel.
- `StellarRelayer.sign` takes `cosigners`, the signers of the operations whose source is another account.
- `StellarRelayer.createSponsoredAccount({ sponsor, account })` returns the three operations creating an account whose reserve is paid by its sponsor, for `sign` with the new account as a cosigner.
- `StellarLedgerEntry` gains `extXdr`, the `LedgerEntryExt` XDR that `getLedgerEntries` returns on recent nodes: it holds the sponsor of the entry.
