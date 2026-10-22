# ADR 0011 — Split payouts and an optional protocol fee

**Status:** Accepted for issue #72 (Phase E6)
**Date:** 2026-10-22

## Context

Integrators asked for two things that the one-payee escrow cannot express:

1. A released escrow paying several parties (for example a marketplace fee, a
   referrer, and the author), without the payer having to run a second
   transaction per recipient.
2. A protocol fee taken by the deploying application, charged in the same
   atomic settlement as the payout.

Both have to work with the existing escrow lifecycle: funding at creation,
release by the releaser (or M-of-N approval), refunds that always return the
escrowed amount, and the "no stranded funds" property the contract already
guarantees.

## Decision

Add a **separate** creation entry point, `create_escrow_with_splits`, rather
than extending `create_escrow`:

```
create_escrow_with_splits(
  payer, payee, token, amount, condition_ref, releaser, refund_after,
  splits, fee_bps, fee_recipient, notify_payee, refund_to,
  release_not_before,
) -> escrow_id
```

`create_escrow`, `create_escrow_release_time`, `create_escrow_with_acceptance`
and `create_escrow_with_releasers` keep their signatures and behaviour.
Deployed clients — notably `sdk-go`, which encodes arguments positionally —
must not be forced to change to keep working.

Splits are stored with the escrow (`splits`, `fee_bps`, `fee_recipient`), so
`get_escrow` shows a payee exactly what a release will pay. A new read-only
`preview_payout(escrow_id)` returns the same numbers as the settlement itself.

### Validation

- 1..=`MAX_RECIPIENTS` (10) split recipients.
- Every `bps` is `> 0`; the shares sum to exactly `BPS_DENOMINATOR` (10,000).
- No duplicate recipients.
- No recipient may be the escrow contract itself.
- `fee_bps <= 10,000`; the fee recipient may not be the escrow contract.
- Splits are **single-releaser only** for now. On a quorum escrow the split
  entry point is not offered; use `create_escrow_with_releasers`.

### Rounding

Take the fee off the top with floor division, then each split with floor
division:

```
fee_amount   = amount * fee_bps / 10_000
distributable = amount - fee_amount
share_i      = distributable * bps_i / 10_000   (floor, i < last)
share_last   = distributable - sum(share_i)
```

Every rounding remainder goes to the **last** recipient, so
`fee_amount + sum(shares) == amount` exactly and no dust is stranded in the
contract. With no splits the payee alone receives `distributable`, which is the
pre-E6 behaviour. The SDK's `computePayout()` mirrors this arithmetic offline.

### Refunds

Refunds ignore both splits and the fee: the full `amount` goes to `refund_to`,
exactly as before. A payer is never charged a fee for an escrow that never paid
out.

### Errors

Appended after the existing discriminants so nothing on testnet is renumbered:

| Value | Variant |
|---|---|
| 26 | `InvalidSplits` |
| 27 | `TooManyRecipients` |
| 28 | `InvalidFee` |

(Discriminant 25 is `BatchTooLarge`, from ADR 0005's batch surface.)

## Consequences

- Integrators get atomic multi-party settlement without a second transaction,
  and can charge a fee without a side contract.
- Payees can price-check a split escrow before relying on it, using
  `get_escrow` or `preview_payout`.
- One more creation entry point to maintain, and the single-releaser
  limitation is a deliberate scope cut: combining splits with M-of-N approvals
  is a separate decision (approvals are not stored, so both paths would need
  their own authorization rules).
- Client-side validation duplicates the contract's checks. That is intentional:
  it fails fast instead of paying a fee for a rejected transaction, and the
  contract remains the authority.
