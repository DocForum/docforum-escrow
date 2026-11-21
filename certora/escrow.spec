// Property specification for the docforum_escrow Soroban contract.
//
// Scope: invariants I1, I2, I3 and I4 from docs/threat-model.md, plus the
// timeout rule from docs/adr/0004, the pooled-escrow rules from
// docs/adr/0011 and the fee-conservation rule from docs/adr/0010. See
// docs/formal-verification.md for what this covers, what it does not, the
// assumptions each property relies on, and the current tooling status.
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
// I4 — an escrow only exists, or grows, if the declared funds were actually
// transferred in — and a pooled escrow's per-contributor accounting is the
// same money, counted once per contributor.
//
// Threat model: "An escrow only exists, or grows, if the declared funds were
// actually transferred in — including every contribution to a pooled
// escrow." ADR 0011 additionally fixes the pooled accounting shape:
// `data.amount == Σ unclaimed contributions`, contributions are recorded only
// after verification, claims pay exactly the recorded amount once, and a
// pooled release requires the target to be met exactly.
// ---------------------------------------------------------------------------

// rule I4.inbound_transfer_moves_exactly_the_declared_amount
//   entry points: create_escrow*, top_up, contribute
//   establish:   every inbound transfer goes through `transfer_in_exact`:
//                it reads the contract's token balance before and after the
//                token `transfer`, and requires
//                balance_after - balance_before == amount (checked math).
//                Otherwise the call fails with Error::BalanceMismatch (6)
//                and no amount or contribution is recorded.
//   violated by: trusting the token's return value, or recording the
//                declared amount before comparing balances — a lying,
//                short-delivering or fee-on-transfer token would then mint
//                an escrow (threat model T5, malicious_token.rs).
//   note:        `amount` here is the declared call argument; the stored
//                `data.amount` only grows in the same invocation that
//                verified the delta.

// rule I4.contribution_recorded_only_after_verification
//   entry point: contribute
//   pre:         status == Funded, now < funding_deadline,
//                0 < amount <= funding_target - data.amount
//   establish:   `payer.require_auth()` is the only source of funds; after
//                `transfer_in_exact` succeeds, `Contribution(escrow_id,
//                payer).amount` grows by exactly `amount` and `data.amount`
//                grows by exactly `amount`, in that invocation. A rejected
//                contribution writes neither.
//   violated by: a zero/negative amount — Error::InvalidAmount (2); a paused
//                contract — Error::Paused (38); a settled escrow —
//                Error::NotFunded (4); a late contribution —
//                Error::FundingDeadlinePassed (27); an amount past the
//                target — Error::FundingTargetReached (28); a failed delta
//                check — Error::BalanceMismatch (6); overflow —
//                Error::Overflow (12).
//   note:        repeated contributions by the same payer accumulate into
//                one record; different payers never share a record.

// rule I4.pooled_total_is_the_sum_of_unclaimed_contributions
//   entry points: contribute, claim_refund, release, release_with_approvals,
//                 settle_many (Release)
//   establish:   for a pooled escrow, `data.amount` (the aggregate the
//                contract owes and releases) equals the sum of
//                `Contribution.amount` over every record whose `refunded`
//                flag is false. `contribute` adds one term, `claim_refund`
//                subtracts exactly the claimed record, and no other entry
//                point changes either side. No path iterates contributor
//                records.
//   violated by: `top_up` growing `data.amount` without a contribution
//                record — rejected with Error::NotSupportedForPooled (33),
//                as are `refund`, `refund_with_approvals` and `cancel`
//                (a push refund to one `refund_to` would violate I1 for the
//                other contributors).
//   note:        settlement keeps the records (ADR 0013), so the equality
//                is still readable after a release; a released escrow's
//                remaining unclaimed records are exactly the contributors
//                whose funds were paid to the payee.

// rule I4.claim_refund_pays_exactly_the_recorded_amount_once
//   entry point: claim_refund
//   pre:         status == Funded, now >= funding_deadline, and
//                data.amount < funding_target (a failed round)
//   establish:   exactly one outbound transfer, to `contributor` (the
//                authenticated caller), for exactly
//                `Contribution(escrow_id, contributor).amount`; the
//                `refunded` flag and `data.amount -= refunded_amount` are
//                written before the transfer, and a failing transfer rolls
//                the invocation back.
//   violated by: a claim before the deadline — Error::RefundNotOpen (30);
//                a claim on a fully funded round —
//                Error::FundingTargetReached (28); an address with no
//                record — Error::NoContribution (32); a second claim —
//                Error::AlreadyRefunded (31); a claim after release —
//                Error::NotFunded (4); Error::NotPooled (26) on a
//                non-pooled escrow. Claiming another address's funds fails
//                the host authorization check in
//                `contributor.require_auth()` (not one of the contract's
//                `Error` values), so the claim never runs.
//   note:        claim order cannot change entitlements: each claim reads
//                and writes only its own record and the aggregate.

// rule I4.pooled_release_requires_the_target_exactly
//   entry points: release, release_with_approvals,
//                 settle_many (Release op)
//   pre:         status == Funded
//   establish:   on a pooled escrow, `data.amount == pooled.funding_target`;
//                otherwise the call fails with Error::FundingIncomplete (29)
//                before any status write or transfer. Non-pooled escrows are
//                unaffected.
//   violated by: releasing a partially funded round, or treating "now past
//                the deadline" as a reason to release.
//   note:        the check runs after `check_funded`, so a settled pooled
//                escrow still reports Error::NotFunded (4) first. Once the
//                target is reached the funding deadline is irrelevant and
//                release proceeds; a claim of a failed round makes
//                `data.amount < funding_target` permanently true.

// ---------------------------------------------------------------------------
// I7 — fee conservation: a declared protocol fee takes exactly once per
// release, fee plus payee payout equal the released amount, and no fee is
// ever taken on a refund or a cancel.
//
// Threat model: "A declared fee takes exactly once per release:
// floor(amount × fee_bps ÷ 10 000) (≤ 10 %) to the fee_recipient fixed at
// creation, the remainder to payee — the two sum to exactly amount — and no
// fee ever moves on the refund path." See docs/adr/0010.
// ---------------------------------------------------------------------------

// rule I7.release_fee_plus_payout_equals_the_stored_amount
//   entry points: release, release_with_approvals,
//                 settle_many (Release op)
//   pre:         status == Funded, settling to Released
//   establish:   let fee = 0 when `fee_recipient`/`fee_bps` is unset, else
//                floor(data.amount × fee_bps ÷ 10 000). Exactly one transfer
//                of `fee` goes to the stored `fee_recipient` (none when
//                fee == 0), and exactly one transfer of `data.amount - fee`
//                goes to the stored `payee` — or, on a multi-payee split
//                escrow (ADR 0014), is distributed to the stored payee set
//                by basis points, the last payee taking the rounding
//                remainder so the shares sum to that remainder. Fee plus
//                every payee transfer sum to exactly `data.amount`, never
//                more and never less.
//   violated by: computing the fee from a call argument, taking the fee out
//                of a different escrow's funds, rounding the fee up (which
//                would make the pair exceed the amount), or forwarding the
//                fee to any address other than the stored recipient.
//   note:        `bps` is validated at creation and re-checked on `top_up`
//                (0 ≤ bps ≤ MAX_FEE_BPS = 1 000; half-set pairs and a
//                contract-self recipient rejected — Error::InvalidFee (35)),
//                and the multiplication is checked, so `fee_amount` cannot
//                overflow into a different split. A fee-transfer failure
//                aborts the release with Error::Undeliverable (36) and rolls
//                back. Pooled escrows store no fee (`fee_recipient: None` at
//                creation), so their whole pooled total goes to the payee.

// rule I7.settle_charges_the_fee_on_the_payee_share_only
//   entry point: settle
//   pre:         status == Funded, single payee, not streamed,
//                0 <= payee_amount <= data.amount
//   establish:   the fee is floor(payee_amount × fee_bps ÷ 10 000) — computed
//                from the payee's gross share, not the whole escrow — and
//                the transfers are: fee to the stored `fee_recipient`,
//                `payee_amount - fee` to the stored `payee`, and
//                `data.amount - payee_amount` to the stored `refund_to`;
//                the three sum to exactly `data.amount`. With payee_amount
//                == 0 (behaves like refund) no fee is taken; with
//                payee_amount == data.amount it matches `release`.
//   violated by: charging the fee on `data.amount` while only part of it is
//                released, or charging again on the refunded remainder.
//   note:        a payee_amount outside [0, data.amount] fails
//                Error::InvalidSettlementAmount (52).

// rule I7.refund_and_cancel_never_pay_fee_recipient
//   entry points: refund, refund_with_approvals, cancel,
//                 settle_many (Refund op)
//   pre:         status == Funded
//   establish:   settling to Refunded or Cancelled performs no transfer to
//                `fee_recipient` and computes no fee: the full stored
//                `data.amount` (less any already-withdrawn vested portion,
//                which still goes to the payee) goes to the stored
//                `refund_to`. The fee fields are not read on these paths.
//   violated by: a fee deduction on a timeout refund, payee-initiated
//                refund, payer cancel or batch refund.
//   note:        pooled refunds are pull-based (`claim_refund`, rule
//                I4.claim_refund_pays_exactly_the_recorded_amount_once)
//                and pay no fee either; pooled escrows store none.

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
// A4. Ledger time is monotonic (host guarantee), so `refund_after`,
//     `release_not_before` and pooled `funding_deadline` cannot un-expire.
// A5. A pooled escrow's `Contribution(escrow_id, payer)` record is the only
//     source of that payer's entitlement: it is written only by
//     `contribute` (add amount) and `claim_refund` (set `refunded`), and
//     persistent storage reads within one invocation are consistent. The
//     aggregate `data.amount` is maintained from those records, not
//     recomputed by iteration.
