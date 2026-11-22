# ADR 0012: First-class milestone escrows

**Status:** Accepted (2026-11-22)

**Issue:** #21

## Context

An ordinary escrow releases its entire funded amount at once. Keeping a
multi-stage agreement as several unrelated escrows leaves the relationship
between tranches off-chain and permits inconsistent settlement decisions.

The contract must preserve its existing single-tranche API, keep the payout
destinations fixed at creation, and ensure that partial settlement cannot
create or destroy value.

## Decision

Milestones use a fixed schedule of positive `i128` amounts whose sum equals
the escrow's `amount`. The schedule is stored under an appended
`DataKey::Milestones` record containing the amounts, one `released` flag per
entry, and a checked running `paid` total. The schedule is immutable after
creation.

The new entry points are:

- `create_escrow_with_milestones(...)`, which funds the whole escrow and
  validates the schedule before authorization or transfer;
- `get_milestones(escrow_id)`, which returns the schedule and settlement
  state; and
- `release_milestone(escrow_id, index, caller)`, which requires the stored
  single releaser and pays one unreleased tranche. Tranches may be released
  in any order.

After one or more tranche releases, the escrow remains `Funded`. The final
tranche changes it to `Released`. A release is checks-effects-interactions:
the flag, running total and terminal status are written before the token
transfer; a failed transfer or opted-in payee callback rolls the invocation
back atomically.

`refund` and `refund_with_approvals` remain available under their existing
authorization and timeout rules. For a milestone escrow they transfer only
`amount - paid` to the stored `refund_to`, then mark the escrow `Refunded`.
No milestone can be released after that terminal transition.

## Alternatives considered

- **Free-form partial release:** rejected because callers could choose
  arbitrary amounts and the intended payment schedule would not be
  auditable on-chain.
- **One escrow per tranche:** retained as the existing SDK compatibility
  model, but rejected for the contract feature because it cannot enforce a
  shared total or atomic schedule validation.
- **Ordered-only release:** rejected; real agreements may complete stages in
  a different order, and independent flags make that rule unnecessary.
- **New `PartiallyReleased` status:** rejected to preserve the four-value
  status vocabulary. `get_milestones` exposes partial progress while
  `Funded` continues to mean funds remain available for settlement.

## Consequences

The contract surface and generated bindings must be regenerated from the new
WASM. Milestone creation pays the resource cost of storing the schedule, and
each release is a separate transaction. The running-total check and
per-tranche flags enforce the generalized I3 invariant: each tranche pays at
most once and total payout never exceeds the original amount.

This feature is testnet-only until the repository's independent security
review is complete.
