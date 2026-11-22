//! Pooled escrows funded by several payers (docs/adr/0011).

use crate::*;

#[contractimpl]
impl EscrowContract {
    /// Creates a pooled escrow funded by many payers (issue #113,
    /// docs/adr/0011). `creator` sets the deal — payee, token, releaser,
    /// opaque `condition_ref`, an explicit `funding_target` (> 0) and a
    /// `funding_deadline` (unix seconds, strictly in the future) — but
    /// funds nothing at creation: `EscrowData.amount` starts at 0 and grows
    /// as contributors call `contribute`. Release becomes possible only
    /// once contributions reach the target exactly; if the deadline passes
    /// first, the round has failed and every contributor pulls their own
    /// recorded amount back with `claim_refund`. `creator` is stored as
    /// the escrow's `payer` (co-authorization for `rotate_releaser` only)
    /// and as the `refund_to` placeholder; no push refund path exists for
    /// pooled escrows. No `refund_after`, no acceptance gate, no callback:
    /// pooled settlement reuses the plain releaser/threshold rules.
    pub fn create_pooled_escrow(
        env: Env,
        creator: Address,
        payee: Address,
        token: Address,
        funding_target: i128,
        condition_ref: String,
        releaser: Address,
        funding_deadline: u64,
    ) -> Result<u64, Error> {
        // Creating a pooled escrow opens a new deposit target, so the
        // emergency pause gates it like every other creation entry point
        // (docs/adr/0011): while paused no id is consumed and nothing is
        // stored.
        if Self::is_paused(env.clone()) {
            return Err(Error::Paused);
        }
        Self::extend_instance_ttl(&env);
        // Validate everything before any auth prompt so a malformed
        // request costs the caller nothing on-chain (same convention as
        // `create_escrow_inner`).
        let allowed_tokens: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::AllowedTokens)
            .unwrap_or(Vec::new(&env));
        if !allowed_tokens.is_empty() && !Self::contains(&allowed_tokens, &token) {
            return Err(Error::DisallowedToken);
        }
        if funding_target <= 0 {
            return Err(Error::InvalidAmount);
        }
        if funding_deadline <= env.ledger().timestamp() {
            return Err(Error::InvalidFundingDeadline);
        }
        if condition_ref.len() > MAX_CONDITION_REF_LEN {
            return Err(Error::ConditionRefTooLong);
        }
        let mut releasers = Vec::new(&env);
        releasers.push_back(releaser);
        Self::check_releaser_set(&env, &releasers, 1)?;

        creator.require_auth();

        let id = Self::next_id(&env);
        let mut pooled_payees = Vec::new(&env);
        pooled_payees.push_back(PayeeShare {
            payee: payee.clone(),
            basis_points: 10_000,
        });
        let data = EscrowData {
            payer: creator.clone(),
            payee: payee.clone(),
            token,
            // Grows with accepted contributions; release pays exactly
            // this pooled total.
            amount: 0,
            condition_ref,
            status: EscrowStatus::Funded,
            releasers,
            threshold: 1,
            // No push timeout exists for pooled escrows, so the field is
            // inert; kept for read-shape compatibility.
            refund_after: None,
            payees: pooled_payees,
            notify_payee: false,
            requires_acceptance: false,
            accepted_at: None,
            // Never used by a payout: pooled refunds are pull-based per
            // contributor. Stored so every `EscrowData` invariant holds.
            refund_to: creator,
            release_not_before: None,
            // Pooled escrows carry no protocol fee (docs/adr/0010 is
            // creation-time only via `create_escrow*`): release pays the
            // pooled total to the payee in full.
            fee_recipient: None,
            fee_bps: None,
            attester: None,
        };
        env.storage().persistent().set(&DataKey::Escrow(id), &data);
        env.storage()
            .persistent()
            .set(&DataKey::Status(id), &data.status);
        env.storage().persistent().set(
            &DataKey::Pooled(id),
            &PooledData {
                funding_target,
                funding_deadline,
            },
        );
        Self::publish_state(&env, symbol_short!("created"), id, &data);
        Ok(id)
    }

    /// Adds `amount` to a pooled escrow from `payer` (issue #113,
    /// docs/adr/0011). Permissionless — anyone may fund — but every
    /// contribution:
    /// - must be a positive amount (`InvalidAmount`);
    /// - is accepted only while the escrow is `Funded` and the ledger
    ///   timestamp is strictly before the funding deadline
    ///   (`FundingDeadlinePassed` after it — late money can never change a
    ///   round's outcome);
    /// - may not push the pooled total past the funding target
    ///   (`FundingTargetReached` — overfunding is rejected, not refunded);
    /// - is pulled from `payer` under `payer.require_auth()` and verified
    ///   with the same exact balance-delta check as creation
    ///   (`BalanceMismatch` if the contract's balance didn't rise by
    ///   exactly `amount`);
    /// - is recorded against `payer` only, accumulating across repeated
    ///   contributions and never touching other payers' records.
    /// Accounting is updated only after the transfer is verified, so a
    /// failed contribution records nothing (invariant I4).
    pub fn contribute(env: Env, escrow_id: u64, payer: Address, amount: i128) -> Result<(), Error> {
        Self::extend_instance_ttl(&env);
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        // `contribute` is how new money enters a pooled escrow, so the
        // emergency pause blocks it (docs/adr/0011). `claim_refund` and
        // `release` never read the flag: a pause cannot trap pooled funds.
        if Self::is_paused(env.clone()) {
            return Err(Error::Paused);
        }
        let mut data: EscrowData = Self::load(&env, escrow_id)?;
        let pooled = Self::pooled_data(&env, escrow_id)?;
        Self::check_funded(&data)?;
        if env.ledger().timestamp() >= pooled.funding_deadline {
            return Err(Error::FundingDeadlinePassed);
        }
        let remaining = pooled
            .funding_target
            .checked_sub(data.amount)
            .ok_or(Error::Overflow)?;
        if amount > remaining {
            return Err(Error::FundingTargetReached);
        }

        payer.require_auth();
        Self::transfer_in_exact(&env, &data.token, &payer, amount)?;

        let key = DataKey::Contribution(escrow_id, payer.clone());
        let mut contribution: Contribution =
            env.storage()
                .persistent()
                .get(&key)
                .unwrap_or(Contribution {
                    amount: 0,
                    refunded: false,
                });
        contribution.amount = contribution
            .amount
            .checked_add(amount)
            .ok_or(Error::Overflow)?;
        let funded = data.amount.checked_add(amount).ok_or(Error::Overflow)?;
        data.amount = funded;
        env.storage().persistent().set(&key, &contribution);
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), &data);
        env.events().publish(
            (symbol_short!("contrib"), escrow_id),
            (payer, amount, funded),
        );
        Ok(())
    }

    /// Pull-based refund (issue #113, docs/adr/0011): pays `contributor`
    /// exactly the amount recorded against that address, once. Available
    /// only for a *failed* funding round — the funding deadline has passed
    /// with the pooled total still below the target (`RefundNotOpen`
    /// otherwise) — and only while the escrow has not been released
    /// (`NotFunded` afterwards: released funds can never be claimed).
    /// Each claim is O(1) work — no path iterates contributors — and its
    /// own authorization: no one can claim on another contributor's
    /// behalf (`NoContribution` for an address with no record), a second
    /// claim fails `AlreadyRefunded`, and the order of claims can never
    /// change anyone's entitlement. Checks-effects-interactions: the
    /// `refunded` flag and the pooled total are written before the
    /// transfer, and a failing transfer rolls the whole claim back.
    pub fn claim_refund(env: Env, escrow_id: u64, contributor: Address) -> Result<(), Error> {
        Self::extend_instance_ttl(&env);
        contributor.require_auth();

        let key = DataKey::Contribution(escrow_id, contributor.clone());
        // The final claim removes the live escrow. Preserve the more useful
        // double-claim error using the durable contribution marker.
        let mut data: EscrowData = match Self::load(&env, escrow_id) {
            Ok(data) => data,
            Err(Error::NotFunded) => {
                if env
                    .storage()
                    .persistent()
                    .get::<_, Contribution>(&key)
                    .is_some_and(|contribution| contribution.refunded)
                {
                    return Err(Error::AlreadyRefunded);
                }
                if Self::pooled_data(&env, escrow_id).is_ok() {
                    return Err(Error::NoContribution);
                }
                return Err(Error::NotFunded);
            }
            Err(error) => return Err(error),
        };
        let pooled = Self::pooled_data(&env, escrow_id)?;
        Self::check_funded(&data)?;
        if env.ledger().timestamp() < pooled.funding_deadline {
            return Err(Error::RefundNotOpen);
        }
        if data.amount >= pooled.funding_target {
            // The round succeeded: release, don't refund.
            return Err(Error::FundingTargetReached);
        }

        let mut contribution: Contribution = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NoContribution)?;
        if contribution.refunded {
            return Err(Error::AlreadyRefunded);
        }
        let refund_amount = contribution.amount;

        // Effects before interaction: mark the claim spent and decrement
        // the pooled total first, so a failed transfer rolls back
        // atomically and can never double-pay (invariant I3).
        contribution.refunded = true;
        data.amount = data
            .amount
            .checked_sub(refund_amount)
            .ok_or(Error::Overflow)?;
        let closes_failed_round = data.amount == 0;
        if closes_failed_round {
            data.status = EscrowStatus::Refunded;
        }
        env.storage().persistent().set(&key, &contribution);
        if closes_failed_round {
            env.storage()
                .persistent()
                .remove(&DataKey::Escrow(escrow_id));
            env.storage()
                .persistent()
                .set(&DataKey::Status(escrow_id), &data.status);
        } else {
            env.storage()
                .persistent()
                .set(&DataKey::Escrow(escrow_id), &data);
        }
        // Issue #39: the pooled total just dropped by `refund_amount`.
        Self::sub_liability(&env, &data.token, refund_amount)?;

        let token_client = token::Client::new(&env, &data.token);
        token_client.transfer(
            &env.current_contract_address(),
            &contributor,
            &refund_amount,
        );
        env.events().publish(
            (symbol_short!("claimed"), escrow_id),
            (contributor, refund_amount),
        );
        if closes_failed_round {
            Self::publish_state(&env, symbol_short!("refunded"), escrow_id, &data);
        }
        Ok(())
    }

    /// Closes a failed pooled round that had no contributions. A round with
    /// contributions reaches the same terminal state on the final claim;
    /// this permissionless path handles the zero-contribution case because
    /// there is no contributor call that could otherwise close it.
    pub fn close_failed_round(env: Env, escrow_id: u64) -> Result<(), Error> {
        Self::extend_instance_ttl(&env);
        let mut data = Self::load(&env, escrow_id)?;
        let pooled = Self::pooled_data(&env, escrow_id)?;
        Self::check_funded(&data)?;
        if env.ledger().timestamp() < pooled.funding_deadline {
            return Err(Error::RefundNotOpen);
        }
        if data.amount >= pooled.funding_target {
            return Err(Error::FundingTargetReached);
        }
        if data.amount != 0 {
            return Err(Error::RefundNotOpen);
        }

        data.status = EscrowStatus::Refunded;
        env.storage()
            .persistent()
            .remove(&DataKey::Escrow(escrow_id));
        env.storage()
            .persistent()
            .set(&DataKey::Status(escrow_id), &data.status);
        Self::publish_state(&env, symbol_short!("refunded"), escrow_id, &data);
        Ok(())
    }

    /// Read-only solvency check for one token (issue #39): returns
    /// `(balance, liabilities)`, where `balance` is this contract's current
    /// balance of `token` and `liabilities` is the sum of `amount` over
    /// every escrow in `token` that is still `Funded` (pooled escrows count
    /// their funded total net of claimed refunds). The contract is solvent
    /// for `token` exactly when `balance >= liabilities`.
    ///
    /// `liabilities` is maintained on-chain by every state change that
    /// moves value — creation, `top_up` and `contribute` add, and
    /// release/refund/cancel/`claim_refund` subtract — in the same
    /// invocation, so it can never drift from the escrows themselves.
    /// A token never used by this contract reports `0` liabilities.
    pub fn solvency(env: Env, token: Address) -> (i128, i128) {
        Self::extend_instance_ttl(&env);
        let balance = token::Client::new(&env, &token).balance(&env.current_contract_address());
        (balance, Self::liability(&env, &token))
    }

    /// Read-only: the immutable funding config of a pooled escrow. The
    /// aggregate funded amount is the escrow's `amount` from `get_escrow`;
    /// a round is failed when `now >= funding_deadline` and `amount <
    /// funding_target` (then `claim_refund` is open to each contributor).
    /// Errors `NotPooled` on a non-pooled or unknown id.
    pub fn get_pooled(env: Env, escrow_id: u64) -> Result<PooledData, Error> {
        Self::extend_instance_ttl(&env);
        Self::pooled_data(&env, escrow_id)
    }

    /// Read-only: one contributor's record on a pooled escrow — the exact
    /// amount they can claim back from a failed round, and whether it has
    /// already been claimed. `None` means the address never contributed.
    /// Errors `NotFound` on an unknown id and `NotPooled` on a
    /// non-pooled escrow.
    pub fn get_contribution(
        env: Env,
        escrow_id: u64,
        contributor: Address,
    ) -> Result<Option<Contribution>, Error> {
        Self::extend_instance_ttl(&env);
        let key = DataKey::Contribution(escrow_id, contributor);
        if !env.storage().persistent().has(&key) {
            // Distinguish "no such escrow" from "wrong escrow kind" so
            // callers can't confuse a missing record with a bad id.
            if !env.storage().persistent().has(&DataKey::Pooled(escrow_id)) {
                if env.storage().persistent().has(&DataKey::Escrow(escrow_id)) {
                    return Err(Error::NotPooled);
                }
                return Err(Error::NotFound);
            }
            return Ok(None);
        }
        Ok(env.storage().persistent().get(&key))
    }
}
