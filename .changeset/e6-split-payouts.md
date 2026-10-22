---
"@docforum/escrow-sdk": minor
---

Add split payouts and a protocol fee on release (Phase E6, issue #72).

- `createEscrow({ splits, fee })` routes to the new
  `create_escrow_with_splits` contract entry point. Split shares are basis
  points summing to exactly 10,000; the fee is basis points taken off the top
  before the shares are applied. Both are fixed at creation, and both are
  ignored by every refund path.
- `client.previewPayout(escrowId)` returns the exact fee and per-recipient
  amounts from the contract's read-only `preview_payout`, and the exported
  `computePayout(total, splits, fee)` performs the same arithmetic offline
  before an escrow exists.
- `getEscrow()` now exposes `splits` and `fee`; `Escrow` gains both fields.
- `validateSplits` / `validateFee` / `EscrowValidationError` reject a bad
  configuration before it costs a network round trip.
- `release()` still returns `{ txHash }`; no existing signature or behaviour
  changed. Design and trade-offs: `docs/adr/0011`.
