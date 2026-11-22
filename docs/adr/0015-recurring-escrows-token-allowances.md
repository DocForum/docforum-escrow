# ADR 0015 — Recurring escrows funded through token allowances

- **Status:** Accepted (2026-11-21)
- **Phase:** E5 — Contract features (issue #115)
- **Deciders:** contract maintainers
- **Related:** [ADR 0001](0001-generic-escrow-not-healthcare-specific.md)
  (who, not why), [ADR 0011](0011-pooled-escrow-funding.md) (deposit
  paths and the pause), `docs/threat-model.md` T26.

## Context

Subscriptions and retainers need a new escrow every period. Asking the
payer to sign each one is friction, and pre-funding a year locks capital.
SEP-41 allowances (`approve` + `transfer_from`) let the payer authorise
future funding up to a cap, and the contract can create each period's
escrow when it is due.

Constraints carried in from the existing design:

- **ADR 0001:** the contract enforces WHO may act, not WHY. A schedule
  carries the same opaque `condition_ref` as an escrow and the contract
  never interprets it.
- **I1:** funds only leave to the stored `payee`, or to the stored
  `refund_to` on refund/cancel. Each period is a normal escrow, so I1
  holds for every period exactly as it holds for a one-off escrow.
- **I3:** each escrow settles at most once. Period escrows are separate
  records with separate ids, so I3 holds per period.
- **ADR 0011:** the emergency pause blocks new deposits. Funding a
  period is a new deposit, so it is gated too.

## Decision

Add a `RecurringSchedule` record and three entry points:
`create_schedule`, `fund_next`, `cancel_schedule`, plus a read-only
`get_schedule`.

### Schedule representation

```rust
pub struct RecurringSchedule {
    pub payer: Address,
    pub payee: Address,
    pub token: Address,
    pub amount: i128,              // pulled for each period
    pub condition_ref: String,     // stored verbatim on every period escrow
    pub releaser: Address,         // single releaser of every period escrow
    pub refund_after_seconds: Option<u64>, // relative refund window, applied per period at funding time
    pub period_seconds: u64,       // seconds between period due times
    pub total_periods: u32,        // how many periods the schedule funds
    pub periods_funded: u32,
    pub next_due: u64,             // ledger timestamp the next period is due
    pub cancelled: bool,
}
```

Stored under `DataKey::RecurringSchedule(schedule_id)`, with ids from a
separate `DataKey::NextScheduleId` counter so schedule ids never consume
escrow ids. `create_schedule` validates the terms before any auth
prompt: positive `amount`, non-zero `period_seconds` and `total_periods`,
`condition_ref` within the 64-byte bound, and the token on the deploy-time
allowlist when one is configured. Only the payer may create a schedule,
and the payer signs that call.

The refund window is relative, not an absolute deadline. `fund_next`
sets each period escrow's `refund_after` to the ledger timestamp at
funding plus `refund_after_seconds` (checked addition), or no deadline
when the schedule stores `None`. An absolute deadline stored at creation
would pass while periods remain, and every later `fund_next` would fail
the creation path's `refund_after <= now` check, so a schedule whose
periods run past its deadline could never complete — and earlier periods
would get much longer refund windows than later ones. A relative window
gives every period the same length of window no matter when it is funded.

Period escrows are plain single-releaser escrows: no fee, no callback,
no acceptance gate, no release time. They are created through the
existing creation path, so allowlist, amount, `condition_ref`,
releaser-set and fee checks all apply unchanged.

### Who may trigger the next period

Anyone, as a keeper. `fund_next` takes no caller address and demands no
signature — neither the keeper's nor the payer's. The payer's allowance
is the authorization: the payer granted this contract the right to pull
up to a cap, and `fund_next` spends it. The token contract enforces both
the cap and the allowance's expiration ledger; an expired allowance
reads as zero, so funding stops on its own. This is the whole point of
the feature: if the payer had to sign each period, the schedule would
save nothing over creating escrows one by one.

The pull itself goes through a `transfer_from` variant of the existing
inbound-transfer helper, with the same balance-delta check against a
lying or short-delivering token (threat model T5) and the same
per-token liability accounting (issue #39).

### Timing and catch-up

A period is due when the ledger timestamp reaches `next_due`. Funding
early fails with `ScheduleTooEarly`. A late trigger funds exactly one
period: `next_due` advances by exactly one `period_seconds` from the
previous due time, not from now. So a schedule three periods behind
needs three `fund_next` calls, one escrow each, and no single call ever
creates several periods at once. The first period is due at `first_due`;
a `first_due` already passed means the first call may run immediately.

### Cancellation

Only the payer may cancel, and the payer signs that call. Cancelling
sets a flag; `fund_next` then fails with `ScheduleCancelled`. Period
escrows already created are independent records and are unaffected —
their funds stay locked under their own terms until released or
refunded. Cancelling twice fails. A schedule that funded every period
fails further funding with `ScheduleComplete`.

### Why a schedule can never pull more than authorised

- Each `fund_next` pulls exactly `amount`, once, and only when a period
  is due, only while periods remain, and only while the schedule is not
  cancelled.
- The token contract enforces the allowance cap: the pull fails when the
  remaining allowance is below `amount`. Total pulls can never exceed
  `total_periods * amount`, and a payer who approves exactly that much
  has capped the schedule completely.
- The payer can stop funding at any time by cancelling, or by setting
  the allowance to zero, or by letting it expire.
- `transfer_from` is only ever called from `fund_next`: no other entry
  point spends the allowance.

## Consequences

- A schedule entry lives in persistent storage and its TTL is
  re-extended on every write. A schedule whose period is longer than
  the TTL window (~180 days) can be archived between fundings and would
  need restoring before the next `fund_next`; monthly and shorter
  periods stay live because funding re-extends the entry.
- No SDK work in this change: keepers and integrators call the new
  entry points directly. The generated spec and SDK bindings need
  regenerating after this lands, as with any new entry point.
- New error codes 55–59 (`ScheduleTooEarly`, `ScheduleComplete`,
  `ScheduleCancelled`, `AllowanceExhausted`, `InvalidSchedule`), provisional
  11500–11504 until the contract 3.3.0 fold.
