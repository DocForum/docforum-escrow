//! `release`, `refund`, `cancel`, quorum variants and `settle_many`.

use crate::*;

#[contractimpl]
impl EscrowContract {
    /// Moves the escrowed `amount` to `payee`. Only the escrow's releaser
    /// may call this — the contract enforces WHO, never WHY (ADR 0001). On
    /// an M-of-N escrow this single-caller path is only allowed when the
    /// threshold is 1; otherwise use `release_with_approvals`.
    ///
    /// Deliberately **not** gated by `refund_after` (docs/adr/0004): after
    /// the deadline the releaser can still release, racing any timeout
    /// refund — whoever lands first wins and the other fails `NotFunded`.
    ///
    /// Also deliberately **not** gated by the emergency pause
    /// (docs/adr/0011): funds must always be able to leave an existing
    /// escrow, whatever state new deposits are in.
    /// If the escrow was created with a fee (docs/adr/0010), the fee comes
    /// off the top — `⌊amount × fee_bps ÷ 10 000⌋` goes to `fee_recipient`,
    /// the exact remainder to `payee`, so the two transfers always sum to
    /// the escrowed `amount`. No fee is ever taken on `refund`.
    pub fn release(env: Env, escrow_id: u64, caller: Address) -> Result<(), Error> {
        Self::extend_instance_ttl(&env);
        caller.require_auth();

        let mut data = Self::release_checks(&env, escrow_id, &caller)?;
        Self::settle_full(&env, escrow_id, &mut data, EscrowStatus::Released)
    }

    /// Moves the escrowed `amount` to `payee` on behalf of an M-of-N
    /// releaser set (docs/adr/0007). Every address in `approvers` must be a
    /// releaser, appear at most once, and authorize this exact invocation;
    /// at least `threshold` distinct approvers are required. Approvals are
    /// not stored between calls, so there is nothing to clear on settlement
    /// and no approval to replay — a settled escrow fails `NotFunded`.
    pub fn release_with_approvals(
        env: Env,
        escrow_id: u64,
        approvers: Vec<Address>,
    ) -> Result<(), Error> {
        Self::extend_instance_ttl(&env);
        let mut data = Self::load(&env, escrow_id)?;
        Self::check_approvals(&env, &data, &approvers)?;
        Self::check_funded(&data)?;
        Self::check_pooled_fully_funded(&env, escrow_id, &data)?;

        Self::settle_full(&env, escrow_id, &mut data, EscrowStatus::Released)
    }

    /// Settles many escrows in one transaction (issue #29, docs/adr/0012) —
    /// the fast path for threat model T1's "race the attacker" response and
    /// for high-volume integrators. Each `(escrow_id, action)` is checked
    /// exactly like the single-escrow entry point it mirrors:
    ///
    /// - `Release`: `caller` must be a releaser of that escrow with
    ///   threshold 1, the escrow must be `Funded`, a pooled escrow must be
    ///   fully funded, and `release_not_before`/payee acceptance apply.
    /// - `Refund`: pooled escrows are rejected; `caller` may be the stored
    ///   payee for a voluntary refund, or must be a releaser (threshold 1)
    ///   unless `refund_after` has passed, in which case anyone may refund —
    ///   always to the stored `refund_to`.
    ///
    /// `caller` authorizes the whole batch once. Per-op authority comes
    /// only from each escrow's own stored releaser set, so a batch can never
    /// settle an escrow whose releaser is someone else: that op returns
    /// `Unauthorized` and touches nothing.
    ///
    /// **Best-effort with per-op results:** the returned vector has one
    /// entry per input op, in input order. `Ok(())` means that escrow was
    /// settled by this call; `Err(e)` means the op was rejected *before*
    /// any state changed and that escrow is exactly as it was. The same
    /// escrow twice in one batch: the first op settles it, the second
    /// returns `NotFunded`. A failure *after* an op's effects began (a
    /// failing token transfer or an opted-in payee callback) cannot be
    /// reported per-op without leaving funds moved under an `Err`, so it
    /// aborts and reverts the whole batch instead.
    ///
    /// `ops.len()` must be `<= MAX_SETTLE_OPS` (`BatchTooLarge`). An empty
    /// batch returns an empty vector.
    ///
    /// Deliberately **not** gated by the emergency pause (docs/adr/0011):
    /// both ops are outbound, exactly like single `release`/`refund`, and a
    /// pause stops new deposits only — it must never block funds leaving.
    pub fn settle_many(
        env: Env,
        caller: Address,
        ops: Vec<(u64, SettleAction)>,
    ) -> Result<Vec<Result<(), Error>>, Error> {
        Self::extend_instance_ttl(&env);
        if ops.len() > MAX_SETTLE_OPS {
            return Err(Error::BatchTooLarge);
        }
        caller.require_auth();

        let mut results: Vec<Result<(), Error>> = Vec::new(&env);
        for (escrow_id, action) in ops.iter() {
            results.push_back(Self::settle_one(&env, escrow_id, &caller, action));
        }
        Ok(results)
    }

    /// Returns the escrowed `amount` to the escrow's `refund_to` (the
    /// `payer` unless a different destination was fixed at creation —
    /// docs/adr/0009). Same state rule as
    /// `release` (only while `Funded`), but two callers are authorised:
    ///
    /// - the escrow's releaser (docs/adr/0002), always; or
    /// - **anyone**, once `refund_after` has been reached — the timeout
    ///   refund path for a lost/unsignable releaser key (docs/adr/0004); or
    /// - the stored payee, at any time while the escrow is `Funded`, as a
    ///   voluntary refund that emits `PayeeRefunded` (ADR 0010).
    ///
    /// The destination never changes: timeout or not, funds only ever go
    /// to the stored `refund_to`, which no caller can influence. With no
    /// `refund_after` set, behaviour is identical to before the timeout
    /// existed — releaser only. On an M-of-N escrow the releaser path needs
    /// a threshold of 1; otherwise use `refund_with_approvals` (the timeout
    /// path stays open to anyone).
    ///
    /// Deliberately **not** gated by the emergency pause (docs/adr/0011):
    /// pausing new deposits must never trap funds already escrowed.
    /// A protocol fee (docs/adr/0010) is never taken on the refund path:
    /// the stored `refund_to` receives the full stored `amount`.
    /// path stays open to anyone). The stored payee may also voluntarily
    /// refund a funded escrow; that path emits `payee_refunded` (ADR 0010).
    /// A protocol fee is never taken on the refund path.
    pub fn refund(env: Env, escrow_id: u64, caller: Address) -> Result<(), Error> {
        Self::extend_instance_ttl(&env);
        caller.require_auth();

        let (mut data, payee_initiated) =
            Self::refund_checks_for_caller(&env, escrow_id, &caller)?;
        Self::settle_full(&env, escrow_id, &mut data, EscrowStatus::Refunded)?;
        if payee_initiated {
            PayeeRefunded {
                escrow_id,
                payer: data.payer,
                payee: data.payee,
                amount: data.amount,
            }
            .publish(&env);
        }
        Ok(())
    }

    /// Lets the payer take the funds back **before the payee accepts**
    /// (docs/adr/0010): returns the escrowed `amount` to `refund_to` (the
    /// `payer` unless a sponsor destination was fixed at creation, ADR
    /// 0009) and marks the escrow `Cancelled`. Allowed only while **all**
    /// hold:
    ///
    /// - `payer` is the escrow's stored payer and authorizes the call;
    /// - the escrow is still `Funded` (`NotFunded` otherwise — never after
    ///   a release, refund or earlier cancel);
    /// - it was created with `requires_acceptance`
    ///   (`AcceptanceNotConfigured` otherwise — without the gate there is
    ///   no acceptance step to race, so no cancel window exists);
    /// - the payee has not accepted (`AlreadyAccepted` otherwise).
    ///
    /// The destination is read from storage, so invariant I1 is unchanged.
    /// Payees: do not rely on a `requires_acceptance` escrow until you
    /// have called `accept`. `accept` and `cancel` race on one ledger
    /// state: whichever lands first wins and the other fails.
    pub fn cancel(env: Env, escrow_id: u64, payer: Address) -> Result<(), Error> {
        Self::extend_instance_ttl(&env);
        payer.require_auth();

        let mut data = Self::load(&env, escrow_id)?;
        // Pooled escrows have no acceptance gate to race and no push
        // refund path at all (docs/adr/0011) — contributors pull their
        // own funds after a missed funding deadline.
        Self::reject_pooled(&env, escrow_id)?;
        if payer != data.payer {
            return Err(Error::Unauthorized);
        }
        Self::check_funded(&data)?;
        if !data.requires_acceptance {
            return Err(Error::AcceptanceNotConfigured);
        }
        if data.accepted_at.is_some() {
            return Err(Error::AlreadyAccepted);
        }

        Self::settle_full(&env, escrow_id, &mut data, EscrowStatus::Cancelled)
    }

    /// Returns the escrowed `amount` to `refund_to` on behalf of an M-of-N
    /// releaser set (docs/adr/0007). Same approval rules as
    /// `release_with_approvals`. The timeout refund path in `refund` stays
    /// available as well: once `refund_after` passes, anyone can return the
    /// funds to the payer without approvals.
    pub fn refund_with_approvals(
        env: Env,
        escrow_id: u64,
        approvers: Vec<Address>,
    ) -> Result<(), Error> {
        Self::extend_instance_ttl(&env);
        let mut data = Self::load(&env, escrow_id)?;
        // See `refund`: pooled escrows never push refunds (docs/adr/0011).
        Self::reject_pooled(&env, escrow_id)?;
        Self::check_approvals(&env, &data, &approvers)?;
        Self::check_funded(&data)?;

        Self::settle_full(&env, escrow_id, &mut data, EscrowStatus::Refunded)
    }
}
