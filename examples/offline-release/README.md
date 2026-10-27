# Offline release / refund (cold key or multisig releaser)

The releaser key is the main trust assumption (threat model T1). These scripts
keep it off any online machine: **prepare** online, **sign** offline, **submit**
from anywhere.

```
online                     offline (one per signer)         online
prepare.mjs  ──prepared.json──▶  sign.mjs  ──signed-*.xdr──▶  submit.mjs
```

Setup: `cd ../../sdk && npm ci && npm run build`, then `npm install` in this folder
(the offline signer only needs `@stellar/stellar-sdk`, not the escrow SDK).

## Single cold key

```sh
ESCROW_CONTRACT_ID=C... node prepare.mjs <escrowId> <releaserPublicKey>     # add --refund for a refund
SIGNER_SECRET=S... node sign.mjs                                            # offline machine, no network needed
ESCROW_CONTRACT_ID=C... node submit.mjs
```

## 2-of-3 multisig releaser (testnet)

1. `node setup-multisig.mjs` creates a funded 2-of-3 account and `multisig.json`.
2. Create an escrow whose `releaser` is that account.
3. `prepare.mjs` with that account as the releaser.
4. Copy `prepared.json` to two signers' machines; each runs `sign.mjs` with their
   own secret and produces their own `signed-<key>.xdr`. They never see each
   other's file.
5. Put both `signed-*.xdr` next to `submit.mjs`; it merges them into one envelope
   and submits.

## What can go wrong, and how it is detected

- **Sequence staleness.** The transaction is built with the source account's
  next sequence number. If the account sends anything else before you submit,
  this transaction is dead. `submit.mjs` catches it before sending
  (`StaleSequenceError`); run `prepare.mjs` again and re-sign. Avoid sending from
  the releaser account while a signing ceremony is in flight.
- **Expiry.** The window is about a day by default (`validForLedgers` to change
  it). After it, `PreparedTransactionExpiredError`.
- **Auth-entry signatures.** When the releaser is the transaction source (as
  here), its envelope signature authorizes the call, so there are no separate
  auth entries to sign and no auth expiration to manage. If a hot account pays
  the fee instead (`source` set to another account), sign the releaser's auth
  entry with `client.signAuthEntries(xdr, releaserKeypair, { validUntilLedger })`
  before signing the envelope; `authValidForLedgers` sets how long that
  signature lasts, for slow offline signing.
- **A different transaction.** `submit.mjs` verifies the merged envelope hashes
  to `prepared.json`'s hash, and merging rejects copies of different transactions.
- **State changed meanwhile.** If the escrow is settled by someone else before you
  submit, the network rejects the call; prepare again if it is still releasable.

Quorum (M-of-N) escrows settle through `releaseWithApprovals`, not this flow.
