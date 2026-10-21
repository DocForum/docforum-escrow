# ADR 0010: Payer `cancel` while an escrow is `Funded` and not yet accepted

Status: Accepted (2026-10-20)

## Context

Payers sometimes fund the wrong payee or the wrong amount. Today only the
escrow's releaser(s) can undo that (`refund`, ADR 0002/0007), or anyone once
`refund_after` has passed (ADR 0004). The payer has no on-chain power after
creation (threat model §2).

Letting the payer take the money back is a common, safe pattern **as long as
the payee has not yet relied on the escrow**. Payee acceptance (ADR 0008,
issue #25) now defines that moment: an escrow created with
`create_escrow_with_acceptance(.., requires_acceptance = true, ..)` stores
`requires_acceptance` and, once the payee calls `accept`, `accepted_at`.
This ADR adds only the payer's side; it reuses those fields and adds no
acceptance mechanism of its own.

Constraints:

- **Invariant I1**: funds only leave an escrow to the stored `payee`
  (release) or the stored `refund_to` (refund/cancel, ADR 0009). No new
  destination.
- **ADR 0001**: the contract enforces WHO and WHEN, never WHY.
- **ADR 0002 / 0004**: no admin or privileged role; a new path must fail
  safe.
- **Hard rule 2**: contract logic changes ship with tests.

## Decision

- `cancel(escrow_id, payer)`: `payer` auth, must equal the stored payer.
  Succeeds only if **all** hold:
  1. status is `Funded` (`NotFunded` otherwise);
  2. the escrow has `requires_acceptance` (`AcceptanceNotConfigured`
     otherwise);
  3. `accepted_at` is `None` (`AlreadyAccepted` otherwise).
  It then settles through the same path as every other payout
  (checks-effects-interactions, ADR 0006): status becomes `Cancelled`, and
  `amount` goes to the stored `refund_to` (the payer unless a sponsor
  destination was fixed at creation — so a sponsor's money returns where
  the funder said).
- New `EscrowStatus::Cancelled` (terminal). **No new error codes**: the
  existing `NotFunded`, `Unauthorized`, `AcceptanceNotConfigured` and
  `AlreadyAccepted` cover every rejection.

### Escrows without `requires_acceptance`: cancel is not available

Without an acceptance step there is no moment at which "the payee relied on
it" becomes true, so a payer cancel would be a unilateral unwind at any
time — the releaser-is-payer case (T8) made universal, silently changing
what every existing escrow guarantees a payee. `cancel` returns
`AcceptanceNotConfigured` and such escrows behave exactly as before.

### Why a distinct `Cancelled` status

Funds end up where a refund sends them, but a payee or integrator reading
`get_status` can tell "the releaser/timeout returned it" from "the payer
withdrew it before I accepted".

### The accept/cancel race

Both calls touch the same storage entry and Soroban applies transactions one
after another, so **whichever lands first wins, the other fails**. Accept
first: `cancel` fails `AlreadyAccepted`. Cancel first: `accept` fails
`NotFunded`. Both orderings in a single ledger are tested in
`tests/cancel.rs`.

### Interaction with the acceptance gate on `release`

With acceptance required, `release` already fails `AcceptanceRequired` until
the payee accepts, so before acceptance only `refund` (releaser/timeout) and
`cancel` can move the funds, and both return them to `refund_to`. After
acceptance `cancel` is closed for good.

### Not after a partial release

This contract has no partial payouts: `release` and `refund` each move the
full `amount` and leave `Funded` in the same call. `cancel` requires
`Funded` and an unaccepted escrow, which excludes it after any payout. Any
future partial-release feature must preserve that and carry its own test.

## Consequences

- **Payees: do not rely on a `requires_acceptance` escrow until you have
  called `accept`.** `Funded` with `accepted_at == None` means the payer can
  take the money back at any time. Read `get_escrow` first (and the T8
  checks: releasers, `refund_after`, `refund_to`).
- The payer's new power is bounded by I1: it only returns the escrow's own
  funds to the stored refund destination, and only before the payee
  committed.
- **`top_up` (#145) stays allowed while the payer can cancel.** It only adds
  the payer's own money; `cancel` returns the stored (topped-up) `amount`,
  so nothing is stranded. After `cancel`, `top_up` fails `NotFunded`. Payees
  should read the final `amount` when they `accept`.
- **ABI change:** `EscrowStatus` gains `Cancelled`, and the contract gains
  `cancel`. SDK consumers that exhaustively match `EscrowStatus` must handle
  the new variant; `@docforum/escrow-sdk` 0.6.0 → 0.7.0 (0.x-minor).
  The live testnet deployment predates this and needs a redeploy.

## Alternatives considered

- **Payer cancel on every escrow, no acceptance concept.** Rejected: it
  removes any payee guarantee and makes the payer an always-on refund
  authority.
- **Time-boxed cancel window.** Rejected: a second clock next to
  `refund_after` that still leaves the payee guessing; explicit acceptance
  lets the payee choose when they commit.
- **Reuse `Refunded` for cancellations.** Rejected: loses the distinction
  above.
