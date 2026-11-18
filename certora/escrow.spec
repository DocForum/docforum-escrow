// Property specification for the docforum_escrow Soroban contract.
//
// Scope: invariants I1, I2 and I3 from docs/threat-model.md, plus the
// timeout rule from docs/adr/0004. See docs/formal-verification.md for what
// this covers, what it does not, the assumptions each property relies on,
// and the current tooling status.
//
// STATUS: this file is the property list for the formal-verification spike
// (issue #101). It is written against the public entry points and error
// discriminants of contracts/escrow/src/lib.rs, but it has NOT been executed
// against the contract: Certora Sunbeam needs a licensed toolchain and
// credentials that this repository's CI does not have, so nothing here is
// wired into .github/workflows/ci.yml. Do not describe these properties as
// "proven" until a run is recorded in docs/formal-verification.md.
//
// Every property below names the entry point it constrains and the Error
// discriminant (contracts/escrow/src/lib.rs) that makes a violating call
// fail. Error codes are part of the ABI: see the `Error` enum. If you
// renumber them, update this file.
//
// Note on destinations: `release` pays `data.payee`; `refund` and `cancel`
// pay `data.refund_to`, which defaults to `data.payer` at creation
// (docs/adr/0009). The destination is read from storage, never from call
// arguments.

// ---------------------------------------------------------------------------
// I1 — funds only leave an escrow to its payee or its stored refund
// destination.
//
// Threat model: "Funds only leave an escrow to that escrow's payee (on
// release) or the escrow's stored refund_to (on refund). No other
// destination exists."
// ---------------------------------------------------------------------------

// rule I1.release_only_to_payee
//   entry points: release, release_with_approvals
//   establish:   token.transfer is called exactly once, with
//                from = env.current_contract_address() and
//                to   = stored_escrow.payee.
//   amount:      stored_escrow.amount — never a call argument.
//   violated by: any path that derives the destination from an argument; the
//                escrow has no such path (see `settle`, lib.rs).
//   payload:     on success status becomes Released (1).

// rule I1.refund_only_to_refund_to
//   entry points: refund, refund_with_approvals, cancel
//   establish:   token.transfer is called exactly once, with
//                from = env.current_contract_address() and
//                to   = stored_escrow.refund_to.
//   amount:      stored_escrow.amount.
//   violated by: substituting the caller for the destination (a
//                "refund to whoever called" bug). The timeout path in
//                `refund` relaxes the caller check only, never the
//                destination.
//   payload:     status becomes Refunded (2) for refund paths and
//                Cancelled (3) for cancel.

// rule I1.no_other_payout_sink
//   entry points: every method of EscrowContract
//   establish:   the only transfers *out of* the contract are the two in
//                `settle` described above; the remaining transfers live in
//                `transfer_in_exact` and move funds *in* from the payer
//                (create, top_up). No admin, sweep, upgrade or
//                arbitrary-call entry point exists.
//   violated by: adding an outbound transfer outside `settle` without a
//                corresponding property here.

// ---------------------------------------------------------------------------
// I2 — only the escrow's releasers (threshold distinct ones for a quorum
// escrow), or anyone after refund_after, can move funds; acceptance adds
// a gate on release.
//
// Threat model: "Only the escrow's releasers can move funds out —
// threshold distinct ones when the escrow was created M-of-N; release
// additionally requires payee acceptance when configured — or, once
// refund_after has passed, anyone at all, and then still only to the
// stored refund_to."
// ---------------------------------------------------------------------------

// rule I2.release_requires_releaser
//   entry point: release
//   pre:         status == Funded
//   establish:   caller is in stored_escrow.releasers, caller authorized
//                this invocation, and stored_escrow.threshold == 1.
//   violated by: a caller outside the releaser set — fails with
//                Error::Unauthorized (3) in `check_single_caller`; a member
//                of a quorum escrow using the single-caller path — fails
//                with Error::ThresholdNotMet (15).
//   note:        the deadline does not relax this rule (ADR 0004); release
//                is never gated by refund_after.

// rule I2.quorum_requires_threshold_distinct_approvers
//   entry points: release_with_approvals, refund_with_approvals
//   pre:         status == Funded
//   establish:   approvers.len() >= stored_escrow.threshold, every distinct
//                approver is in stored_escrow.releasers, and every approver
//                authorized this invocation.
//   violated by: too few approvers — Error::ThresholdNotMet (15); an
//                approver outside the set — Error::Unauthorized (3); the
//                same address twice — Error::DuplicateApprover (16).
//   note:        approvals are not stored, so there is nothing to replay.

// rule I2.refund_authorization
//   entry point: refund
//   pre:         status == Funded
//   establish:   either caller is an authorised releaser of a threshold-1
//                escrow, or
//                (stored_escrow.refund_after is Some(deadline) and
//                 env.ledger().timestamp() >= deadline).
//   violated by: an unrelated caller before the deadline — fails with
//                Error::Unauthorized (3); a quorum member before the
//                deadline — Error::ThresholdNotMet (15).
//   note:        with refund_after == None the timeout disjunct is never
//                available, which matches pre-timeout behaviour.

// rule I2.cancel_requires_unaccepted_acceptance_escrow
//   entry point: cancel
//   pre:         status == Funded
//   establish:   caller == stored_escrow.payer, caller authorized, the
//                escrow was created with requires_acceptance, and
//                accepted_at == None.
//   violated by: a non-payer — Error::Unauthorized (3); an escrow without
//                the gate — Error::AcceptanceNotConfigured (19); an already
//                accepted escrow — Error::AlreadyAccepted (20);
//                a settled escrow — Error::NotFunded (4).

// rule I2.release_requires_acceptance_when_configured
//   entry points: release, release_with_approvals
//   pre:         status == Funded
//   establish:   stored_escrow.requires_acceptance implies
//                stored_escrow.accepted_at != None.
//   violated by: releasing an opted-in escrow the payee has not accepted —
//                Error::AcceptanceRequired (18) in `settle`.

// rule I2.release_not_before_respected
//   entry points: release, release_with_approvals
//   pre:         status == Funded
//   establish:   stored_escrow.release_not_before is None, or
//                env.ledger().timestamp() >= it.
//   violated by: releasing early — Error::ReleaseTooEarly (23) in `settle`.

// ---------------------------------------------------------------------------
// I3 — at most one payout per escrow.
//
// Threat model: "Each escrow pays out at most once."
// ---------------------------------------------------------------------------

// rule I3.status_is_terminal_after_settlement
//   entry points: release, release_with_approvals, refund,
//                 refund_with_approvals, cancel
//   pre:         status == Funded
//   establish:   on success the status becomes exactly one of Released (1),
//                Refunded (2) or Cancelled (3), and no later invocation of
//                any entry point changes it again: the only writer is
//                `settle`, and every settlement path first enforces
//                `check_funded` (status == Funded, else Error::NotFunded
//                (4)).
//   violated by: a second release/refund/cancel on a settled escrow —
//                Error::NotFunded (4).
//   note:        `top_up` and `rotate_releaser` also refuse a non-Funded
//                escrow with Error::NotFunded (4) and never change status.

// rule I3.failed_settlement_leaves_status_funded
//   entry points: release, release_with_approvals, refund,
//                 refund_with_approvals, cancel
//   establish:   if the invocation returns Err or the token transfer aborts,
//                status is still Funded and the escrow amount is unchanged.
//   rationale:   `settle` writes status before the transfer and the host
//                rolls the whole invocation back on a panic, so success and
//                the payout side effect cannot diverge.
//   violated by: releasing/marking settled before checking whether the
//                transfer succeeded, without rollback.

// ---------------------------------------------------------------------------
// Assumptions (not proved; see docs/formal-verification.md "Assumptions")
// ---------------------------------------------------------------------------
// A1. The token behaves like SEP-41: transfer moves exactly the requested
//     amount or fails, balances are consistent, and it cannot re-enter the
//     escrow. `transfer_in_exact`'s balance-delta check is the runtime guard
//     behind the "exactly" half (Error::BalanceMismatch (6), threat model T5).
// A2. The host rejects re-entry into a contract already on the call stack
//     (threat model T4). `settle` additionally writes status before the
//     transfer, so safety does not rest on A2 alone.
// A3. The deployed WASM is immutable and has no admin function.
// A4. Ledger time is monotonic (host guarantee), so `refund_after` and
//     `release_not_before` cannot un-expire.
