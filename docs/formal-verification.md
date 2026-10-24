# Formal verification spike — invariants I1–I3

Status: **specification, not a completed proof.** The properties for
invariants I1–I3 live in [`certora/escrow.spec`](../certora/escrow.spec). They
are written against the current contract's public entry points and `Error`
discriminants and are checked in so they can be reviewed, but they have **not**
been executed against the contract: Certora Sunbeam requires a licensed
toolchain and credentials this repository does not have on CI. Nothing in
`docs/threat-model.md` or the README should be read as "proven" — the honest
status is "specified, awaiting a run".

This document is the reference for *what* the spike covers, *which* code it
constrains, what it assumes, and what it deliberately leaves out.

## Scope

In scope — the settlement state machine in `contracts/escrow/src/lib.rs`:

| Entry point | Property |
|---|---|
| `release`, `release_with_approvals` | only a releaser (or `threshold` distinct approvers) may release; destination is the stored payee; release requires acceptance when configured; `release_not_before` respected; at most once |
| `refund`, `refund_with_approvals` | releaser (or `threshold` distinct approvers) until `refund_after`; anyone at or after it; destination is always the stored `refund_to`; at most once |
| `cancel` | only the payer, only before the payee accepts an acceptance-gated escrow; destination is the stored `refund_to`; at most once |
| `top_up`, `rotate_releaser` | never change status away from `Funded`; refuse a settled escrow with `Error::NotFunded` (4) |
| `settle` (internal) | the single writer of `status`; it enforces `check_funded` before writing, writes status *before* the transfer, and lets a failing transfer abort the whole invocation |

The properties are stated per method so each one is falsifiable by a single
counterexample. The mapping to the threat model is:

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

The error discriminants each property relies on (`Unauthorized` 3,
`NotFunded` 4, `ThresholdNotMet` 15, `DuplicateApprover` 16,
`AcceptanceRequired` 18, `AcceptanceNotConfigured` 19, `AlreadyAccepted` 20,
`ReleaseTooEarly` 23) are part of the ABI — see the `Error` enum in
`contracts/escrow/src/lib.rs`. A renumbering is a breaking change and requires
updating both the spec and this document.

## Out of scope

These are covered by tests, not by the property list above:

- creation-time validation (`Amount`, `InvalidRefundAfter`,
  `ConditionRefTooLong`, `DisallowedToken`, `InvalidThreshold`,
  `TooManyReleasers`, `DuplicateReleaser`, `InvalidRefundTo`,
  `InvalidReleaseNotBefore`) — exercised by `tests/create_escrow.rs`,
  `tests/quorum.rs`, `tests/sponsored_refund.rs`,
  `tests/time_locked_release.rs`, `tests/token_allowlist.rs`;
- the payee callback and its revert semantics
  (`Error::CallbackFailed` 9) — `tests/release_callback.rs`;
- token hostility, including the balance-delta check
  (`Error::BalanceMismatch` 6) — `tests/malicious_token.rs`;
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
   admin, pause or upgrade entry point.
4. **A4 — monotonic time.** Ledger timestamps never decrease, so
   `refund_after` and `release_not_before` cannot un-expire.

## Running the properties

Once a licensed toolchain and `CERTORAKEY` are available, a run has to be
recorded here with the tool version, contract commit, and per-rule result —
until then this section is intentionally empty. Do not add a CI job that
invokes the tool with a secret that does not exist: a job that always fails or
silently skips is worse than an honest manual step.

## Maintaining this spike

The spec names paths inside `lib.rs` (`settle`, `check_funded`,
`check_single_caller`, `check_approvals`) and error discriminants. If you
change the settlement state machine, update `certora/escrow.spec` and this
document in the same PR; a stale property list is worse than none, because it
reads as coverage that no longer exists.
