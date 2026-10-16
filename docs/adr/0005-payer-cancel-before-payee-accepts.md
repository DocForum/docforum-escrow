# ADR 0005: Payer `cancel` while an escrow is `Funded` and not yet accepted

Status: Accepted (2026-10-16)

## Context

Payers sometimes fund the wrong payee or the wrong amount. Today only the
escrow's `releaser` can undo that (`refund`, ADR 0002), or anyone once
`refund_after` has passed (ADR 0004). The payer has no on-chain power at
all after `create_escrow` (threat model §2).

Letting the payer take the money back is a common, safe pattern **as long
as the payee has not yet relied on the escrow**. That needs a defined
moment at which the payee commits: payee acceptance. Issue #27 lists that
as a dependency ("the payee acceptance issue opened alongside this one").
It had not landed when this was written, so this change includes the
smallest acceptance mechanism that makes the cancellation window
well-defined: a `requires_acceptance` flag fixed at creation and an
`accept` call. If the acceptance issue lands with a different shape, the
merge conflict is confined to those two items; `cancel`'s rules below
depend only on "was `accept` called".

Constraints:

- **Invariant I1** (threat model §1): funds only leave an escrow to the
  stored `payee` (release) or `payer` (refund/cancel). No new destination.
- **ADR 0001**: the contract enforces WHO and WHEN, never WHY.
- **ADR 0002 / 0004**: no admin, no privileged role; the failure direction
  of any new path must be safe.
- **Hard rule 2**: contract logic changes ship with tests.

## Decision

### Surface

- `create_escrow(..., refund_after, requires_acceptance: bool)`. Stored
  in `EscrowData` together with `accepted: bool` (starts `false`).
- `accept(escrow_id, payee)`: `payee` auth, must equal the stored payee.
  Only while `Funded`, only once. Moves no funds.
- `cancel(escrow_id, payer)`: `payer` auth, must equal the stored payer.
  Succeeds only if **all** hold:
  1. the escrow has `requires_acceptance`;
  2. status is `Funded`;
  3. `accepted` is `false`.
  Then it transfers `amount` to the stored `payer` and sets status to
  `Cancelled`.
- New `EscrowStatus::Cancelled`, new errors `AcceptanceNotRequired = 7`
  and `AlreadyAccepted = 8` (`BalanceMismatch = 6` is untouched).

### Escrows without `requires_acceptance`: cancel is **not available**

`cancel` and `accept` return `AcceptanceNotRequired`. Reasons:

- Without an acceptance step there is no moment at which "the payee has
  relied on it" becomes true, so a payer cancel would be a unilateral
  unwind at any time. That is the releaser-is-payer case (T8) made
  universal, and would silently change what every existing escrow
  guarantees a payee.
- It keeps the guarantee "escrows created without `requires_acceptance`
  behave exactly as before" literally true: no new caller can move their
  funds.

### Why a distinct `Cancelled` status

Funds end up in the same place as a refund, but a payee or integrator
reading `get_status` can distinguish "the releaser/timeout returned it"
from "the payer withdrew it before I accepted". Folding it into
`Refunded` would lose that.

### The accept/cancel race

Soroban applies transactions one after another, both touch the same
storage entry, so there is no in-between state: **whichever lands first
wins, the other fails.** Accept first: `cancel` fails `AlreadyAccepted`.
Cancel first: `accept` fails `NotFunded`. Both orderings, inside a single
ledger, are tested in `tests/cancel_accept.rs`. The loser's transaction
fails without side effects.

### "Not after a partial milestone release"

This contract has no milestones or partial payouts: `release` and
`refund` each move the full `amount` and leave `Funded` in the same
call, so no state exists where some funds have left and the escrow is
still `Funded`. `cancel` requires `Funded`, which already excludes it
after any payout, and it additionally requires `!accepted`. Any future
partial-release feature must keep that property (either by making a
partial release set `accepted`, or by extending `cancel`'s guards) and
carry its own test; that obligation is recorded here so it is not missed.

### `release` and `refund` are unchanged

The releaser can still `release`/`refund` an escrow that requires
acceptance before it is accepted; `refund_after` still applies. Gating
`release` on acceptance is a separate decision that belongs to the
acceptance issue, not to the cancellation window.

## Consequences

- **Payees: do not rely on an escrow until you have accepted it.** For an
  escrow with `requires_acceptance`, `Funded` plus `accepted == false`
  means the payer can take the money back at any time. Read
  `get_escrow` and require `accepted == true` (and the T8 checks:
  `releaser`, `refund_after`).
- The payer's new power is bounded by I1: it can only ever return the
  payer's own money to the payer, and only before the payee committed.
- **Breaking change** to the contract ABI (`create_escrow` gains a
  parameter, `EscrowData` gains two fields, `EscrowStatus` gains a
  variant) and therefore to the SDK: `@docforum/escrow-sdk` 0.3.0 →
  0.4.0 (0.x-minor-for-breaking, same convention as 0.2.0 → 0.3.0).
  Consumers pass `requiresAcceptance: false` (the default) to keep the
  old behaviour. The live testnet deployment predates this change and
  must be redeployed before the SDK integration tests can target it.

## Alternatives considered

- **Payer cancel on every escrow, no acceptance concept.** Rejected: see
  above, it removes any payee guarantee and makes the payer an
  always-on refund authority.
- **Time-boxed cancel window (payer may cancel for N seconds).** Rejected:
  adds a second clock next to `refund_after` and still leaves the payee
  guessing; explicit acceptance gives them control of when they commit.
- **Reuse `Refunded` for cancellations.** Rejected: loses the
  distinction described above.
