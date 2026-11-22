//! Recurring escrows funded through SEP-41 token allowances (issue #115,
//! ADR 0015).
//!
//! A payer records a schedule once; any keeper may then call `fund_next`
//! when a period is due. Each call pulls exactly one period's `amount`
//! with `transfer_from` under the allowance the payer granted this
//! contract, and creates a normal escrow for that period through the
//! existing creation path. The payer's allowance is the authorization:
//! no signature is needed at fund time, the payer can shrink or revoke
//! the allowance, and the payer may cancel the schedule at any time.
//! Period escrows already created are independent records and are
//! unaffected by a cancel.

use crate::*;
use crate::internal::Funding;

#[contractimpl]
impl EscrowContract {
    /// Records a recurring funding schedule. Nothing is funded yet: the
    /// payer grants the allowance separately, with the token's own
    /// `approve`, up to whatever cap they choose. The first period is due
    /// at `first_due`; a `first_due` already passed means the first
    /// `fund_next` may run immediately. Like every deposit path, this is
    /// gated by the emergency pause (docs/adr/0011).
    pub fn create_schedule(
        env: Env,
        payer: Address,
        payee: Address,
        token: Address,
        amount: i128,
        condition_ref: String,
        releaser: Address,
        refund_after_seconds: Option<u64>,
        period_seconds: u64,
        total_periods: u32,
        first_due: u64,
    ) -> Result<u64, Error> {
        Self::extend_instance_ttl(&env);
        if Self::is_paused(env.clone()) {
            return Err(Error::Paused);
        }
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if period_seconds == 0 || total_periods == 0 {
            return Err(Error::InvalidSchedule);
        }
        if condition_ref.len() > MAX_CONDITION_REF_LEN {
            return Err(Error::ConditionRefTooLong);
        }
        let allowed_tokens: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::AllowedTokens)
            .unwrap_or(Vec::new(&env));
        if !allowed_tokens.is_empty() && !Self::contains(&allowed_tokens, &token) {
            return Err(Error::DisallowedToken);
        }
        payer.require_auth();

        let schedule_id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextScheduleId)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::NextScheduleId, &(schedule_id + 1));
        let schedule = RecurringSchedule {
            payer: payer.clone(),
            payee: payee.clone(),
            token: token.clone(),
            amount,
            condition_ref,
            releaser,
            refund_after_seconds,
            period_seconds,
            total_periods,
            periods_funded: 0,
            next_due: first_due,
            cancelled: false,
        };
        env.storage()
            .persistent()
            .set(&DataKey::RecurringSchedule(schedule_id), &schedule);
        Self::extend_schedule_ttl(&env, schedule_id);
        env.events().publish(
            (
                symbol_short!("schedule"),
                symbol_short!("created"),
                schedule_id,
            ),
            (
                payer,
                payee,
                token,
                amount,
                period_seconds,
                total_periods,
                first_due,
            ),
        );
        Ok(schedule_id)
    }

    /// Funds the next due period of a schedule. Anyone may call it (a
    /// keeper): the payer's allowance is the authorization, so neither
    /// the keeper nor the payer signs. Exactly one period is funded per
    /// call — a late trigger never creates several periods at once; the
    /// next period simply becomes due immediately and needs another call.
    /// Returns the new period escrow's id.
    pub fn fund_next(env: Env, schedule_id: u64) -> Result<u64, Error> {
        Self::extend_instance_ttl(&env);
        if Self::is_paused(env.clone()) {
            return Err(Error::Paused);
        }
        let mut schedule: RecurringSchedule = env
            .storage()
            .persistent()
            .get(&DataKey::RecurringSchedule(schedule_id))
            .ok_or(Error::NotFound)?;
        if schedule.cancelled {
            return Err(Error::ScheduleCancelled);
        }
        if schedule.periods_funded >= schedule.total_periods {
            return Err(Error::ScheduleComplete);
        }
        if env.ledger().timestamp() < schedule.next_due {
            return Err(Error::ScheduleTooEarly);
        }
        // Each period escrow gets its own refund deadline: now plus the
        // schedule's relative window. An absolute deadline stored at
        // creation would pass while periods remain, and every later
        // fund_next would fail the creation path's refund_after <= now
        // check — the schedule could never complete.
        let refund_after = match schedule.refund_after_seconds {
            Some(seconds) => Some(
                env.ledger()
                    .timestamp()
                    .checked_add(seconds)
                    .ok_or(Error::Overflow)?,
            ),
            None => None,
        };
        let mut releasers = Vec::new(&env);
        releasers.push_back(schedule.releaser.clone());
        let escrow_id = Self::create_escrow_with_payees_inner(
            &env,
            schedule.payer.clone(),
            schedule.payee.clone(),
            schedule.token.clone(),
            schedule.amount,
            schedule.condition_ref.clone(),
            releasers,
            1,
            refund_after,
            false,
            false,
            None,
            None,
            None,
            None,
            None,
            true,
            None,
            Funding::Allowance,
        )?;
        schedule.periods_funded = schedule
            .periods_funded
            .checked_add(1)
            .ok_or(Error::Overflow)?;
        schedule.next_due = schedule
            .next_due
            .checked_add(schedule.period_seconds)
            .ok_or(Error::Overflow)?;
        env.storage()
            .persistent()
            .set(&DataKey::RecurringSchedule(schedule_id), &schedule);
        Self::extend_schedule_ttl(&env, schedule_id);
        env.events().publish(
            (
                symbol_short!("schedule"),
                symbol_short!("funded"),
                schedule_id,
            ),
            (escrow_id, schedule.periods_funded, schedule.next_due),
        );
        Ok(escrow_id)
    }

    /// Cancels a schedule. Only the payer, who must authorize. Period
    /// escrows already created are independent records and are unaffected.
    pub fn cancel_schedule(env: Env, schedule_id: u64, payer: Address) -> Result<(), Error> {
        Self::extend_instance_ttl(&env);
        payer.require_auth();
        let mut schedule: RecurringSchedule = env
            .storage()
            .persistent()
            .get(&DataKey::RecurringSchedule(schedule_id))
            .ok_or(Error::NotFound)?;
        if payer != schedule.payer {
            return Err(Error::Unauthorized);
        }
        if schedule.cancelled {
            return Err(Error::ScheduleCancelled);
        }
        schedule.cancelled = true;
        env.storage()
            .persistent()
            .set(&DataKey::RecurringSchedule(schedule_id), &schedule);
        Self::extend_schedule_ttl(&env, schedule_id);
        env.events().publish(
            (
                symbol_short!("schedule"),
                symbol_short!("cancel"),
                schedule_id,
            ),
            (payer, schedule.periods_funded),
        );
        Ok(())
    }

    /// Read-only accessor for a schedule's stored record.
    pub fn get_schedule(env: Env, schedule_id: u64) -> Result<RecurringSchedule, Error> {
        Self::extend_instance_ttl(&env);
        env.storage()
            .persistent()
            .get(&DataKey::RecurringSchedule(schedule_id))
            .ok_or(Error::NotFound)
    }
}

impl EscrowContract {
    /// Keeps a schedule entry live: re-extended on every write, so a
    /// schedule that keeps being funded stays readable. A schedule whose
    /// period is longer than this window can still be restored after
    /// archival; see ADR 0015.
    pub(crate) fn extend_schedule_ttl(env: &Env, schedule_id: u64) {
        let extend_to = ESCROW_EXTEND_TO.min(env.storage().max_ttl());
        let threshold = ESCROW_TTL_THRESHOLD.min(extend_to);
        env.storage().persistent().extend_ttl(
            &DataKey::RecurringSchedule(schedule_id),
            threshold,
            extend_to,
        );
    }
}
