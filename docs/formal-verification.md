# Formal verification spike — invariants I1–I4 and fee conservation (I7)

Status: **specification, not a completed proof.** The properties for
invariants I1–I4 and I7 live in [`certora/escrow.spec`](../certora/escrow.spec).
They are written against the current contract's public entry points and
`Error` discriminants and are checked in so they can be reviewed, but they
have **not** been executed against the contract: Certora Sunbeam requires a
licensed toolchain and credentials this repository does not have on CI.
Nothing in `docs/threat-model.md` or the README should be read as "proven" —
the honest status is "specified, awaiting a run".

The pooled-escrow properties (I4) and the fee-conservation properties (I7)
were added in issue #317 on top of the original I1–I3 spike (issue #101).
They are likewise unexecuted.

This document is the reference for *what* the spike covers, *which* code it
constrains, what it assumes, and what it deliberately leaves out.

## Scope

In scope — the settlement state machine in `contracts/escrow/src/`:

| Entry point | Property |
|---|---|
| `release`, `release_with_approvals` | only a releaser (or `threshold` distinct approvers) may release; destination is the stored payee; release requires acceptance when configured; `release_not_before` respected; at most once |
| `refund`, `refund_with_approvals` | releaser (or `threshold` distinct approvers) until `refund_after`; anyone at or after it; destination is always the stored `refund_to`; at most once |
| `cancel` | only the payer, only before the payee accepts an acceptance-gated escrow; destination is the stored `refund_to`; at most once |
| `top_up`, `rotate_releaser` | never change status away from `Funded`; refuse a settled escrow with `Error::NotFunded` (4) |
| `settle` (internal) | the single writer of `status`; it enforces `check_funded` before writing, writes status *before* the transfer, and lets a failing transfer abort the whole invocation |
| `create_escrow*`, `top_up`, `contribute` | every inbound amount is verified by the exact balance delta in `transfer_in_exact` before any amount or contribution is stored (`Error::BalanceMismatch`, 6) |
| `contribute` (pooled) | a contribution is recorded against its payer only after verification; repeated contributions accumulate; the pooled total grows by exactly the verified amount |
| `claim_refund` (pooled) | pays the caller's own recorded amount exactly once, only from a failed round (deadline passed, target unmet); the contributor's `require_auth` is the only authorization; order-independent; no contributor iteration |
| pooled `release`, `release_with_approvals`, `settle_many` (Release op) | releases only when the pooled total equals the funding target exactly (`Error::FundingIncomplete`, 29) |
| `release`, `release_with_approvals`, `settle_many` (Release op) | a declared fee is taken once, `floor(amount × fee_bps ÷ 10 000)` to the stored `fee_recipient`, the remainder to the stored `payee` (or split by basis points across the stored payee set); fee plus payee transfers sum to the stored amount |
| `settle` | a split release charges the fee on the payee's share only; fee plus payee net plus refunded remainder equal the stored amount |
| `refund`, `refund_with_approvals`, `cancel`, `settle_many` (Refund op), pooled `claim_refund` | no fee is computed and no transfer reaches `fee_recipient`; the stored `refund_to` (or the contributor) receives the full amount |

The properties are stated per method so each one is falsifiable by a single
counterexample. The mapping to the threat model and ADRs is:

- **I1** — `I1.release_only_to_payee`, `I1.refund_only_to_refund_to`,
  `I1.no_other_payout_sink`. Destination and amount come from storage; the
  timeout path in `refund` relaxes the caller, never the destination.
- **I2** — `I2.release_requires_releaser`,
  `I2.quorum_requires_threshold_distinct_approvers`,
  `I2.refund_authorization`, `I2.cancel_requires_unaccepted_acceptance_escrow`,
  `I2.release_requires_acceptance_when_configured`,
  `I2.release_not_before_respected`.
- **I3** — `I3.status_is_terminal_after_settlement`,
  `I3.failed_settlement_leaves_status_funded`.
- **I4** (pooled accounting, ADR 0011) —
  `I4.inbound_transfer_moves_exactly_the_declared_amount`,
  `I4.contribution_recorded_only_after_verification`,
  `I4.pooled_total_is_the_sum_of_unclaimed_contributions`,
  `I4.claim_refund_pays_exactly_the_recorded_amount_once`,
  `I4.pooled_release_requires_the_target_exactly`.
- **I7** (fee conservation, ADR 0010) —
  `I7.release_fee_plus_payout_equals_the_stored_amount`,
  `I7.settle_charges_the_fee_on_the_payee_share_only`,
  `I7.refund_and_cancel_never_pay_fee_recipient`.

The error discriminants each property relies on (`Unauthorized` 3,
`NotFunded` 4, `BalanceMismatch` 6, `Overflow` 12, `ThresholdNotMet` 15,
`DuplicateApprover` 16, `AcceptanceRequired` 18,
`AcceptanceNotConfigured` 19, `AlreadyAccepted` 20, `ReleaseTooEarly` 23,
`NotPooled` 26, `FundingDeadlinePassed` 27, `FundingTargetReached` 28,
`FundingIncomplete` 29, `RefundNotOpen` 30, `AlreadyRefunded` 31,
`NoContribution` 32, `NotSupportedForPooled` 33, `InvalidFee` 35,
`Undeliverable` 36, `Paused` 38, `InvalidSettlementAmount` 52) are part of
the ABI — see the `Error` enum in `contracts/escrow/src/errors.rs`. A
renumbering is a breaking change and requires updating both the spec and this
document.

## Out of scope

These are covered by tests, not by the property list above:

- creation-time validation (`Amount`, `InvalidRefundAfter`,
  `ConditionRefTooLong`, `DisallowedToken`, `InvalidThreshold`,
  `TooManyReleasers`, `DuplicateReleaser`, `InvalidRefundTo`,
  `InvalidReleaseNotBefore`, `InvalidFee`) — exercised by
  `tests/create_escrow.rs`, `tests/quorum.rs`, `tests/sponsored_refund.rs`,
  `tests/time_locked_release.rs`, `tests/token_allowlist.rs`,
  `tests/protocol_fee.rs`;
- pooled creation validation (`InvalidAmount`, `InvalidFundingDeadline`,
  `ConditionRefTooLong`, `DisallowedToken`, `Paused`) and the deliberate
  rejection of the push paths on pooled escrows
  (`NotSupportedForPooled`) — `tests/pooled.rs`, `tests/pause.rs`;
- the payee callback and its revert semantics
  (`Error::CallbackFailed` 9) — `tests/release_callback.rs`;
- token hostility, including the balance-delta check
  (`Error::BalanceMismatch` 6) on creation, top-up and contribution —
  `tests/malicious_token.rs`;
- TTL/archival behaviour and restoration (threat model T6);
- the SDK surface entirely.

## Assumptions

The properties are only meaningful under these assumptions; a reviewer should
challenge them rather than accept them.

1. **A1 — SEP-41 token.** `transfer` moves exactly the requested amount or
   fails, balances are consistent, and the token cannot re-enter the escrow.
   `transfer_in_exact`'s balance-delta check is the runtime guard for the
   "exactly" half and fails with `BalanceMismatch` (6). A fee-on-transfer or
   lying token is outside the model.
2. **A2 — host re-entry rule.** Soroban rejects a call back into a contract
   already on the stack. `settle` writes status before the transfer, so I3
   does not depend on A2 alone.
3. **A3 — immutability.** The deployed WASM is immutable and there is no
   admin or upgrade entry point. (The emergency pause, ADR 0011, gates
   deposits only and is therefore compatible with I8.)
4. **A4 — monotonic time.** Ledger timestamps never decrease, so
   `refund_after`, `release_not_before` and a pooled `funding_deadline`
   cannot un-expire.
5. **A5 — contribution record integrity.** A pooled contributor's
   `Contribution(escrow_id, payer)` record is the only source of that
   payer's entitlement. It is written only by `contribute` (add amount) and
   `claim_refund` (set `refunded`), and persistent-storage reads within one
   invocation are consistent. The aggregate `EscrowData.amount` is
   maintained from those records (checked adds/subtracts), never recomputed
   by iterating contributors.

## Running the properties

Once a licensed toolchain and `CERTORAKEY` are available, a run has to be
recorded here with the tool version, contract commit, and per-rule result —
until then this section is intentionally empty. Do not add a CI job that
invokes the tool with a secret that does not exist: a job that always fails or
silently skips is worse than an honest manual step.

## Maintaining this spike

The spec names paths inside the contract source (`settle`, `check_funded`,
`check_single_caller`, `check_approvals`, `transfer_in_exact`,
`check_pooled_fully_funded`, `fee_amount`) and error discriminants. If you
change the settlement state machine, the pooled funding rules
(`contracts/escrow/src/pooled.rs`, ADR 0011) or the fee split
(`contracts/escrow/src/internal.rs`, `contracts/escrow/src/settle.rs`,
ADR 0010), update `certora/escrow.spec` and this document in the same PR; a
stale property list is worse than none, because it reads as coverage that no
longer exists.
