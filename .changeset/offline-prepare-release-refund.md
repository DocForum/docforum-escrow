---
"@docforum/escrow-sdk": minor
---

Add offline prepare / merge / submit for `release` and `refund` (issue #59), so a
releaser key can stay cold or be a classic multisig account.

New surface (builds on `submitSigned` from the create flow):

- `prepareRelease({ escrowId, releaser, source?, validForLedgers?, authValidForLedgers? })`
  and `prepareRefund(...)` return an unsigned `PreparedTransaction`. The default
  window is about a day (`OFFLINE_PREPARED_TX_TTL_LEDGERS`) for slow offline
  signing.
- `mergeSignatures([signedXdr, ...])` combines separately signed copies of one
  transaction into a single envelope, rejecting copies of a different
  transaction and dropping duplicate signatures.
- `signAuthEntries(preparedXdr, keypair, { validUntilLedger? })` signs the
  releaser's Soroban auth entry when a different account is the source.
- `submitSigned` already detects a moved source sequence (`StaleSequenceError`)
  and expiry (`PreparedTransactionExpiredError`).

Additive: no existing method changes, so no migration is needed. Single-releaser
escrows only; M-of-N quorum escrows still use `releaseWithApprovals`.
