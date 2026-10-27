---
"@docforum/escrow-sdk": minor
---

Add a prepare / sign elsewhere / submit flow for `create_escrow` (issue #58), so a
payer can sign in a browser wallet while a backend builds and submits.

New surface:

- `prepareCreateEscrow({ payer, ... })` takes the payer's public key (no secret),
  builds and simulates the call, and returns `{ xdr, hash, validUntilLedger,
  source, authSigners, authValidUntilLedger }`. The transaction is bounded by
  ledger bounds, so it expires at `validUntilLedger`.
- `submitSigned(signedXdr, { expectedHash?, feeBumpSigner?, maxFee?, baseFee? })`
  verifies the hash, the ledger window and the source sequence, optionally wraps
  the transaction in a capped fee-bump, submits, polls to completion and returns
  `{ txHash, innerTxHash, escrowId? }`.
- `PreparedTransactionExpiredError`, `StaleSequenceError`,
  `SignedTransactionMismatchError`, `UnsignedTransactionError`.

Additive: `createEscrow` and every existing method are unchanged, so no migration
is needed. The fee-bump cap is enforced against the fee actually charged,
including the Soroban resource fee.
