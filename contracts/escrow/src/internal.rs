//! Shared creation, authorization and settlement internals.

use crate::*;

/// How an escrow's funds arrive (issue #115): a normal creation pulls
/// them with `transfer` under the payer's signature; a recurring period
/// pulls them with `transfer_from` under the payer's pre-granted
/// allowance, so the keeper triggering it needs no signature.
pub(crate) enum Funding {
    /// Pull with `token.transfer`, payer authorizes this invocation.
    Transfer,
    /// Pull with `token.transfer_from` under an existing allowance.
    /// The payer does not authorize this invocation; the allowance is
    /// the authorization.
    Allowance,
}

impl EscrowContract {
    pub(crate) fn create_escrow_inner(
        env: &Env,
        payer: Address,
        payee: Address,
        token: Address,
        amount: i128,
        condition_ref: String,
        releasers: Vec<Address>,
        threshold: u32,
        refund_after: Option<u64>,
        notify_payee: bool,
        requires_acceptance: bool,
        refund_to: Option<Address>,
        release_not_before: Option<u64>,
        fee_recipient: Option<Address>,
        fee_bps: Option<u32>,
        attester: Option<BytesN<32>>,
        payer_already_authorized: bool,
    ) -> Result<u64, Error> {
        Self::create_escrow_with_payees_inner(
            env,
            payer,
            payee,
            token,
            amount,
            condition_ref,
            releasers,
            threshold,
            refund_after,
            notify_payee,
            requires_acceptance,
            refund_to,
            release_not_before,
            fee_recipient,
            fee_bps,
            attester,
            payer_already_authorized,
            None,
            Funding::Transfer,
        )
    }

    pub(crate) fn create_escrow_with_payees_inner(
        env: &Env,
        payer: Address,
        payee: Address,
        token: Address,
        amount: i128,
        condition_ref: String,
        releasers: Vec<Address>,
        threshold: u32,
        refund_after: Option<u64>,
        notify_payee: bool,
        requires_acceptance: bool,
        refund_to: Option<Address>,
        release_not_before: Option<u64>,
        fee_recipient: Option<Address>,
        fee_bps: Option<u32>,
        attester: Option<BytesN<32>>,
        payer_already_authorized: bool,
        payee_shares: Option<Vec<PayeeShare>>,
        funding: Funding,
    ) -> Result<u64, Error> {
        // Every creation entry point funnels through here, so this one
        // check covers all deposit paths: while paused, no new escrow can
        // be created, no id is consumed and no funds move (docs/adr/0011).
        if Self::is_paused(env.clone()) {
            return Err(Error::Paused);
        }
        Self::extend_instance_ttl(env);
        let allowed_tokens: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::AllowedTokens)
            .unwrap_or(Vec::new(env));
        if !allowed_tokens.is_empty() && !Self::contains(&allowed_tokens, &token) {
            return Err(Error::DisallowedToken);
        }
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        Self::check_amount_cap(env, &token, amount)?;
        let payees = if let Some(payees) = payee_shares {
            if payees.is_empty() {
                return Err(Error::InvalidPayeeList);
            }
            if payees.len() > MAX_PAYEES {
                return Err(Error::TooManyPayees);
            }
            let mut total_bps = 0u32;
            let mut seen = Vec::new(env);
            for share in payees.iter() {
                if share.basis_points == 0 {
                    return Err(Error::InvalidBasisPoints);
                }
                total_bps = total_bps
                    .checked_add(share.basis_points)
                    .ok_or(Error::InvalidBasisPoints)?;
                // A share paid to the contract itself would be locked here
                // forever (same rule as `refund_to` and the fee recipient).
                if share.payee == env.current_contract_address() {
                    return Err(Error::InvalidPayeeList);
                }
                if Self::contains(&seen, &share.payee) {
                    return Err(Error::DuplicatePayee);
                }
                seen.push_back(share.payee);
            }
            if total_bps != 10_000 {
                return Err(Error::InvalidBasisPoints);
            }
            payees
        } else {
            let mut shares = Vec::new(env);
            shares.push_back(PayeeShare {
                payee: payee.clone(),
                basis_points: 10_000,
            });
            shares
        };
        if payees
            .iter()
            .any(|share| share.payee == env.current_contract_address())
        {
            return Err(Error::InvalidPayeeList);
        }
        if let Some(deadline) = refund_after {
            if deadline <= env.ledger().timestamp() {
                return Err(Error::InvalidRefundAfter);
            }
        }
        if let Some(release_time) = release_not_before {
            if release_time < env.ledger().timestamp()
                || refund_after.is_some_and(|refund_time| release_time > refund_time)
            {
                return Err(Error::InvalidReleaseNotBefore);
            }
        }
        // Bound condition_ref to keep per-escrow storage and event costs
        // predictable (threat model T10, Phase E5). 64 bytes is generous
        // for a UUID or short label while capping spam risk.
        if condition_ref.len() > MAX_CONDITION_REF_LEN {
            return Err(Error::ConditionRefTooLong);
        }
        Self::check_releaser_set(env, &releasers, threshold)?;
        let refund_to = refund_to.unwrap_or_else(|| payer.clone());
        if refund_to == env.current_contract_address() {
            return Err(Error::InvalidRefundTo);
        }
        // The optional protocol fee is one (recipient, bps) pair fixed at
        // creation; a recipient without a rate or a rate without a
        // recipient is not a coherent configuration — reject it, along
        // with a cap above 10 %, a self-directed fee and fee math that
        // would overflow (docs/adr/0010). All of it is checked before any
        // auth prompt or transfer, so a malformed request costs nothing.
        match (&fee_recipient, &fee_bps) {
            (None, None) => {}
            (Some(_), None) | (None, Some(_)) => return Err(Error::InvalidFee),
            (Some(recipient), Some(bps)) => {
                if *bps > MAX_FEE_BPS {
                    return Err(Error::InvalidFee);
                }
                if *recipient == env.current_contract_address() {
                    return Err(Error::InvalidFee);
                }
                Self::fee_amount(amount, *bps)?;
            }
        }

        // `require_auth` can only run once per address in a frame, so a batch
        // authorizes up front instead of once per item.
        if !payer_already_authorized {
            payer.require_auth();
        }
        if notify_payee {
            payee.require_auth();
        }

        match funding {
            Funding::Transfer => Self::transfer_in_exact(env, &token, &payer, amount)?,
            Funding::Allowance => Self::transfer_from_exact(env, &token, &payer, amount)?,
        }

        let id = Self::next_id(env);
        let data = EscrowData {
            payer,
            payee,
            token,
            amount,
            condition_ref,
            status: EscrowStatus::Funded,
            releasers,
            threshold,
            refund_after,
            payees,
            notify_payee,
            requires_acceptance,
            accepted_at: None,
            refund_to,
            release_not_before,
            fee_recipient,
            fee_bps,
            attester,
        };
        env.storage().persistent().set(&DataKey::Escrow(id), &data);
        env.storage()
            .persistent()
            .set(&DataKey::Status(id), &data.status);
        Self::extend_escrow_ttl(env, id, refund_after);
        Self::publish_state(env, symbol_short!("created"), id, &data);
        Ok(id)
    }

    /// Validates the creation-time releaser set (docs/adr/0007). Run before
    /// any auth prompt or transfer so a malformed request costs the caller
    /// nothing on-chain.
    pub(crate) fn check_releaser_set(
        env: &Env,
        releasers: &Vec<Address>,
        threshold: u32,
    ) -> Result<(), Error> {
        if releasers.len() > MAX_RELEASERS {
            return Err(Error::TooManyReleasers);
        }
        if threshold == 0 || threshold > releasers.len() {
            return Err(Error::InvalidThreshold);
        }
        let mut seen: Vec<Address> = Vec::new(env);
        for releaser in releasers.iter() {
            if releaser == env.current_contract_address() {
                return Err(Error::InvalidReleaser);
            }
            if Self::contains(&seen, &releaser) {
                return Err(Error::DuplicateReleaser);
            }
            seen.push_back(releaser);
        }
        Ok(())
    }

    /// Enforces the immutable constructor cap against the complete amount
    /// held by one escrow. A token without a table entry is uncapped.
    pub(crate) fn check_amount_cap(env: &Env, token: &Address, amount: i128) -> Result<(), Error> {
        let caps: Vec<(Address, i128)> = env
            .storage()
            .instance()
            .get(&DataKey::AmountCaps)
            .unwrap_or(Vec::new(env));
        for (capped_token, max_amount) in caps.iter() {
            if capped_token == *token && amount > max_amount {
                return Err(Error::AmountCapExceeded);
            }
        }
        Ok(())
    }

    /// Authorizes the single-caller `release`/`refund` entry points: the
    /// caller must be a releaser, and the escrow must settle on one
    /// signature (threshold 1). A member of a larger quorum gets
    /// `ThresholdNotMet` rather than `Unauthorized`, so integrators can tell
    /// "wrong address" from "use the approvals entry point".
    pub(crate) fn check_single_caller(data: &EscrowData, caller: &Address) -> Result<(), Error> {
        if !Self::contains(&data.releasers, caller) {
            return Err(Error::Unauthorized);
        }
        if data.threshold != 1 {
            return Err(Error::ThresholdNotMet);
        }
        Ok(())
    }

    /// Authorizes an M-of-N settlement (docs/adr/0007): at least `threshold`
    /// distinct releasers, each of whom authorizes this exact invocation.
    /// Duplicates are rejected rather than deduplicated so a caller cannot
    /// mistake a 2-of-3 with one repeated address for a satisfied threshold.
    pub(crate) fn check_approvals(
        env: &Env,
        data: &EscrowData,
        approvers: &Vec<Address>,
    ) -> Result<(), Error> {
        if approvers.len() < data.threshold {
            return Err(Error::ThresholdNotMet);
        }
        let mut seen: Vec<Address> = Vec::new(env);
        for approver in approvers.iter() {
            if !Self::contains(&data.releasers, &approver) {
                return Err(Error::Unauthorized);
            }
            if Self::contains(&seen, &approver) {
                return Err(Error::DuplicateApprover);
            }
            seen.push_back(approver.clone());
            approver.require_auth();
        }
        Ok(())
    }

    /// Writes the settled state, then transfers the funds out.
    ///
    /// Checks-effects-interactions (docs/adr/0013): the status write comes
    /// before the token call, so safety doesn't rest on the host's re-entry
    /// rule alone (threat model T4). A failing transfer panics inside the
    /// token contract, which aborts and rolls back this whole invocation —
    /// including the status write — so a failed payout can never leave an
    /// escrow marked `Released`/`Refunded`.
    pub(crate) fn settle_full(
        env: &Env,
        escrow_id: u64,
        data: &mut EscrowData,
        settled: EscrowStatus,
    ) -> Result<(), Error> {
        if settled == EscrowStatus::Released
            && data
                .release_not_before
                .is_some_and(|release_time| env.ledger().timestamp() < release_time)
        {
            return Err(Error::ReleaseTooEarly);
        }
        let schedule: Option<VestingSchedule> =
            env.storage().persistent().get(&DataKey::Vesting(escrow_id));
        let withdrawn: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::Withdrawn(escrow_id))
            .unwrap_or(0);
        let total: i128 = if schedule.is_some() {
            env.storage()
                .persistent()
                .get(&DataKey::TotalAmount(escrow_id))
                .ok_or(Error::NotStreamed)?
        } else {
            data.amount
        };
        let (payee_amount, refund_amount) = match (&settled, &schedule) {
            (EscrowStatus::Released, Some(_)) => (data.amount, 0),
            (EscrowStatus::Refunded | EscrowStatus::Cancelled, Some(schedule)) => {
                let vested = Self::vested_amount(total, schedule, env.ledger().timestamp());
                let unpaid_vested = vested.saturating_sub(withdrawn).min(data.amount);
                (unpaid_vested, data.amount - unpaid_vested)
            }
            (EscrowStatus::Released, None) => (data.amount, 0),
            (EscrowStatus::Refunded | EscrowStatus::Cancelled, None) => (0, data.amount),
            (EscrowStatus::Funded, _) => return Err(Error::NotFunded),
        };
        let notify_payee = data.notify_payee && settled == EscrowStatus::Released;
        if settled == EscrowStatus::Released
            && data.requires_acceptance
            && data.accepted_at.is_none()
        {
            return Err(Error::AcceptanceRequired);
        }
        // Fee off the top on release only (docs/adr/0010): one transfer to
        // `fee_recipient`, then the exact remainder to the payee, so the two
        // always sum to the stored `amount`. Rounding floors, so the fee can
        // never exceed its bps share. Both fields were validated together at
        // creation (and re-checked on `top_up`), so the no-fee arm is the
        // only other reachable one. A refund never reads the fee fields and
        // returns the full `amount`.
        let (fee, fee_recipient) = match settled {
            EscrowStatus::Released => match (&data.fee_recipient, &data.fee_bps) {
                (Some(recipient), Some(bps)) => (
                    Self::fee_amount(data.amount, *bps)?,
                    Some(recipient.clone()),
                ),
                _ => (0, None),
            },
            _ => (0, None),
        };
        let payout = payee_amount - fee;

        // Effects before interactions: the state write lands before any
        // token call, so a re-entrant token cannot see a still-`Funded`
        // escrow (threat model T4).
        data.status = settled.clone();
        env.storage()
            .persistent()
            .set(&DataKey::Status(escrow_id), &data.status);
        if schedule.is_some() {
            let settled_withdrawn = withdrawn.checked_add(payee_amount).ok_or(Error::Overflow)?;
            env.storage()
                .persistent()
                .set(&DataKey::Withdrawn(escrow_id), &settled_withdrawn);
        }
        // Issue #39: the escrow leaves `Funded` in this same write, so its
        // amount stops being owed here too.
        Self::sub_liability(env, &data.token, data.amount)?;
        if env.storage().persistent().has(&DataKey::Pooled(escrow_id)) {
            // Pooled escrows keep their full record: contributions, pull-based
            // refunds and `get_pooled` all read it after settlement, so
            // reclaiming it would change those reads (docs/adr/0013).
            env.storage()
                .persistent()
                .set(&DataKey::Escrow(escrow_id), data);
            env.storage().persistent().extend_ttl(
                &DataKey::Escrow(escrow_id),
                SETTLED_ESCROW_TTL_THRESHOLD,
                SETTLED_ESCROW_EXTEND_TO,
            );
        } else {
            // Reclaim storage (docs/adr/0013): the full record is published by
            // `publish_state` below and then removed; the `Status` entry
            // written above is all that remains. Written before the transfer
            // (docs/adr/0013); a failed payout or callback rolls the whole
            // invocation back, including this.
            env.storage()
                .persistent()
                .remove(&DataKey::Escrow(escrow_id));
        }
        env.storage().persistent().extend_ttl(
            &DataKey::Status(escrow_id),
            SETTLED_ESCROW_TTL_THRESHOLD,
            SETTLED_ESCROW_EXTEND_TO,
        );

        let token_client = token::Client::new(env, &data.token);
        if settled == EscrowStatus::Released {
            if let Some(recipient) = fee_recipient {
                if fee > 0 {
                    let transfer = token_client.try_transfer(
                        &env.current_contract_address(),
                        &recipient,
                        &fee,
                    );
                    if !matches!(transfer, Ok(Ok(()))) {
                        return Err(Error::Undeliverable);
                    }
                }
            }
        }
        if payout > 0 {
            if settled == EscrowStatus::Released && data.payees.len() > 1 {
                // Split payout (issue #22): each share by basis points, the
                // last payee taking the rounding remainder so the shares
                // always sum to `payout`.
                let mut distributed = 0i128;
                for index in 0..data.payees.len() {
                    let share = data.payees.get(index).ok_or(Error::InvalidPayeeList)?;
                    let amount = if index + 1 == data.payees.len() {
                        payout
                            .checked_sub(distributed)
                            .ok_or(Error::SplitAmountOverflow)?
                    } else {
                        let quotient = payout / BASIS_POINTS;
                        let remainder = payout % BASIS_POINTS;
                        quotient
                            .checked_mul(share.basis_points as i128)
                            .and_then(|whole| {
                                remainder
                                    .checked_mul(share.basis_points as i128)
                                    .map(|fraction| whole + fraction / BASIS_POINTS)
                            })
                            .ok_or(Error::SplitAmountOverflow)?
                    };
                    distributed = distributed
                        .checked_add(amount)
                        .ok_or(Error::SplitAmountOverflow)?;
                    if amount > 0 {
                        let transfer = token_client.try_transfer(
                            &env.current_contract_address(),
                            &share.payee,
                            &amount,
                        );
                        if !matches!(transfer, Ok(Ok(()))) {
                            return Err(Error::Undeliverable);
                        }
                    }
                }
            } else if settled == EscrowStatus::Released {
                let transfer = token_client.try_transfer(
                    &env.current_contract_address(),
                    &data.payee,
                    &payout,
                );
                if !matches!(transfer, Ok(Ok(()))) {
                    return Err(Error::Undeliverable);
                }
            } else {
                token_client.transfer(&env.current_contract_address(), &data.payee, &payout);
            }
        }
        if refund_amount > 0 {
            token_client.transfer(
                &env.current_contract_address(),
                &data.refund_to,
                &refund_amount,
            );
        }
        if notify_payee {
            // The callback reports what the payee actually received — gross
            // minus any protocol fee — not the gross escrowed amount.
            let args = (escrow_id, payout).into_val(env);
            let callback = env.try_invoke_contract::<(), soroban_sdk::Error>(
                &data.payee,
                &soroban_sdk::Symbol::new(env, "on_escrow_released"),
                args,
            );
            match callback {
                Ok(Ok(())) => {}
                _ => return Err(Error::CallbackFailed),
            }
        }
        let action = match &data.status {
            EscrowStatus::Funded => symbol_short!("created"),
            EscrowStatus::Released => symbol_short!("released"),
            EscrowStatus::Refunded => symbol_short!("refunded"),
            EscrowStatus::Cancelled => symbol_short!("cancelled"),
        };
        Self::publish_state(env, action, escrow_id, data);
        Ok(())
    }

    /// Emits a complete state snapshot for indexers, with releaser sets
    /// preserved for M-of-N escrows.
    pub(crate) fn publish_state(
        env: &Env,
        action: soroban_sdk::Symbol,
        id: u64,
        data: &EscrowData,
    ) {
        let status = match &data.status {
            EscrowStatus::Funded => symbol_short!("Funded"),
            EscrowStatus::Released => symbol_short!("Released"),
            EscrowStatus::Refunded => symbol_short!("Refunded"),
            EscrowStatus::Cancelled => symbol_short!("Cancelled"),
        };
        env.events().publish(
            (symbol_short!("ESCROW"), action, id),
            (
                data.payer.clone(),
                data.payee.clone(),
                data.token.clone(),
                data.amount,
                data.condition_ref.clone(),
                data.releasers.clone(),
                data.threshold,
                data.refund_after,
                data.notify_payee,
                data.requires_acceptance,
                data.accepted_at,
                status,
                // The fee is one nested (recipient, bps) pair: soroban-sdk's
                // event payloads support tuples of at most 13 values, and
                // keeping the pair atomic matches how it is stored
                // (docs/adr/0010).
                (data.fee_recipient.clone(), data.fee_bps),
            ),
        );
    }

    /// Every check `release` makes before settling, minus the caller's
    /// `require_auth` (which the entry point does once). Shared by
    /// `release` and `settle_many` so the two can never disagree.
    pub(crate) fn release_checks(
        env: &Env,
        escrow_id: u64,
        caller: &Address,
    ) -> Result<EscrowData, Error> {
        let data = Self::load(env, escrow_id)?;
        Self::check_single_caller(&data, caller)?;
        Self::check_funded(&data)?;
        Self::check_pooled_fully_funded(env, escrow_id, &data)?;
        Ok(data)
    }

    /// Every check `refund` makes before settling, minus `require_auth`.
    /// Shared by `refund` and `settle_many`.
    pub(crate) fn refund_checks(
        env: &Env,
        escrow_id: u64,
        caller: &Address,
    ) -> Result<EscrowData, Error> {
        let data = Self::load(env, escrow_id)?;
        // A pooled escrow's funds belong to its contributors until the
        // deadline decides the round; a push refund to one `refund_to`
        // would violate per-contributor accounting (docs/adr/0011).
        // Pooled refunds are pull-based: `claim_refund`.
        Self::reject_pooled(env, escrow_id)?;

        let timeout_passed = match data.refund_after {
            Some(deadline) => env.ledger().timestamp() >= deadline,
            None => false,
        };
        if !timeout_passed {
            Self::check_single_caller(&data, caller)?;
        }
        Self::check_funded(&data)?;
        Ok(data)
    }

    /// Resolves the same caller-dependent refund path as `refund` without
    /// requiring auth a second time. The batch entry point authenticates its
    /// caller once, then uses this helper so a payee-initiated refund has the
    /// same authorization and event semantics as the single-entry point.
    pub(crate) fn refund_checks_for_caller(
        env: &Env,
        escrow_id: u64,
        caller: &Address,
    ) -> Result<(EscrowData, bool), Error> {
        let loaded = Self::load(env, escrow_id)?;
        if caller == &loaded.payee {
            Self::reject_pooled(env, escrow_id)?;
            Self::check_funded(&loaded)?;
            Ok((loaded, true))
        } else {
            Ok((Self::refund_checks(env, escrow_id, caller)?, false))
        }
    }

    /// One `settle_many` op. Every rejection is returned before any state
    /// changes: the action's own checks, then `settle()`'s pre-write
    /// release checks (`release_not_before`, payee acceptance), run here
    /// so `settle()` can't return them after this op's effects. An error
    /// `settle()` does return can only come after its status write and
    /// transfer (a failed payee callback), so it aborts the whole batch
    /// rather than be reported as a clean per-op `Err` (docs/adr/0012).
    pub(crate) fn settle_one(
        env: &Env,
        escrow_id: u64,
        caller: &Address,
        action: SettleAction,
    ) -> Result<(), Error> {
        let (mut data, settled, payee_initiated) = match action {
            SettleAction::Release => {
                let data = Self::release_checks(env, escrow_id, caller)?;
                if data
                    .release_not_before
                    .is_some_and(|release_time| env.ledger().timestamp() < release_time)
                {
                    return Err(Error::ReleaseTooEarly);
                }
                if data.requires_acceptance && data.accepted_at.is_none() {
                    return Err(Error::AcceptanceRequired);
                }
                (data, EscrowStatus::Released, false)
            }
            SettleAction::Refund => {
                let (data, payee_initiated) =
                    Self::refund_checks_for_caller(env, escrow_id, caller)?;
                (data, EscrowStatus::Refunded, payee_initiated)
            }
        };
        if let Err(error) = Self::settle_full(env, escrow_id, &mut data, settled) {
            panic_with_error!(env, error);
        }
        if payee_initiated {
            PayeeRefunded {
                escrow_id,
                payer: data.payer,
                payee: data.payee,
                amount: data.amount,
            }
            .publish(env);
        }
        Ok(())
    }

    /// The protocol fee taken off the top at release: the escrowed `amount`
    /// scaled by `bps` (of 10 000), rounded **down** so the fee is never
    /// more than its share and fee + payee remainder always equals the
    /// released `amount` (docs/adr/0010). Overflow of the scaled
    /// multiplication is rejected as `InvalidFee` — checked at creation
    /// (before funds are locked) and again defensively at release, where it
    /// can no longer occur, and after a `top_up`, which re-checks it.
    pub(crate) fn fee_amount(amount: i128, bps: u32) -> Result<i128, Error> {
        amount
            .checked_mul(i128::from(bps))
            .and_then(|scaled| scaled.checked_div(BASIS_POINTS))
            .ok_or(Error::InvalidFee)
    }

    /// Loads the full record of a funded escrow. A settled id answers
    /// `NotFunded` — what it returned before the record was reclaimed
    /// (docs/adr/0013) — and only a never-created id is `NotFound`.
    pub(crate) fn load(env: &Env, escrow_id: u64) -> Result<EscrowData, Error> {
        if let Some(data) = env.storage().persistent().get(&DataKey::Escrow(escrow_id)) {
            return Ok(data);
        }
        if env.storage().persistent().has(&DataKey::Status(escrow_id)) {
            return Err(Error::NotFunded);
        }
        Err(Error::NotFound)
    }

    pub(crate) fn check_funded(data: &EscrowData) -> Result<(), Error> {
        if data.status != EscrowStatus::Funded {
            return Err(Error::NotFunded);
        }
        Ok(())
    }

    /// Loads a pooled escrow's immutable funding config, or errors
    /// `NotPooled` for any escrow without one (issue #113, ADR 0011).
    pub(crate) fn pooled_data(env: &Env, escrow_id: u64) -> Result<PooledData, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Pooled(escrow_id))
            .ok_or(Error::NotPooled)
    }

    /// Rejects an entry point that must never act on a pooled escrow
    /// (push `refund`, `refund_with_approvals`, `cancel`, `top_up` — see
    /// docs/adr/0011 for why each would break per-contributor accounting).
    pub(crate) fn reject_pooled(env: &Env, escrow_id: u64) -> Result<(), Error> {
        if env.storage().persistent().has(&DataKey::Pooled(escrow_id)) {
            return Err(Error::NotSupportedForPooled);
        }
        Ok(())
    }

    /// Pooled escrows release only when fully funded (issue #113): a
    /// round below its target — whatever the clock says — can never pay
    /// the payee; its funds belong to the contributors via
    /// `claim_refund` once the deadline passes. Non-pooled escrows are
    /// unaffected. Runs after the `Funded` status check, so a settled
    /// escrow still reports `NotFunded` first.
    pub(crate) fn check_pooled_fully_funded(
        env: &Env,
        escrow_id: u64,
        data: &EscrowData,
    ) -> Result<(), Error> {
        if let Some(pooled) = env
            .storage()
            .persistent()
            .get::<_, PooledData>(&DataKey::Pooled(escrow_id))
        {
            if data.amount != pooled.funding_target {
                return Err(Error::FundingIncomplete);
            }
        }
        Ok(())
    }

    pub(crate) fn contains(list: &Vec<Address>, candidate: &Address) -> bool {
        for item in list.iter() {
            if &item == candidate {
                return true;
            }
        }
        false
    }
}
