//! Ids, token transfers, liabilities, vesting math and TTL helpers.

use crate::*;

impl EscrowContract {
    pub(crate) fn next_id(env: &Env) -> u64 {
        let id: u64 = env.storage().instance().get(&DataKey::NextId).unwrap_or(0);
        env.storage().instance().set(&DataKey::NextId, &(id + 1));
        id
    }

    pub(crate) fn transfer_in_exact(
        env: &Env,
        token: &Address,
        payer: &Address,
        amount: i128,
    ) -> Result<(), Error> {
        let token_client = token::Client::new(env, token);
        let contract_address = env.current_contract_address();
        let balance_before = token_client.balance(&contract_address);
        token_client.transfer(payer, &contract_address, &amount);
        let balance_after = token_client.balance(&contract_address);
        if balance_after.checked_sub(balance_before) != Some(amount) {
            return Err(Error::BalanceMismatch);
        }
        // Issue #39: every inbound transfer (creation, `top_up`,
        // `contribute`) goes through here, and each one increases a
        // `Funded` escrow's amount by exactly `amount` in the same
        // invocation, so this is where the liability grows.
        Self::add_liability(env, token, amount)
    }

    /// Pulls `amount` of `token` from `payer` under the allowance the
    /// payer granted this contract (issue #115): the allowance is the
    /// payer's authorization, so no signature is needed at pull time —
    /// that is what lets any keeper trigger `fund_next`. The token
    /// contract enforces both the allowance cap and its expiration
    /// ledger; an expired allowance reads as zero. Like
    /// `transfer_in_exact`, the balance delta is verified (threat model
    /// T5) and the liability grows by the same amount.
    pub(crate) fn transfer_from_exact(
        env: &Env,
        token: &Address,
        payer: &Address,
        amount: i128,
    ) -> Result<(), Error> {
        let token_client = token::Client::new(env, token);
        let contract_address = env.current_contract_address();
        if token_client.allowance(payer, &contract_address) < amount {
            return Err(Error::AllowanceExhausted);
        }
        let balance_before = token_client.balance(&contract_address);
        token_client.transfer_from(&contract_address, payer, &contract_address, &amount);
        let balance_after = token_client.balance(&contract_address);
        if balance_after.checked_sub(balance_before) != Some(amount) {
            return Err(Error::BalanceMismatch);
        }
        Self::add_liability(env, token, amount)
    }

    /// Current outstanding liability for `token`; `0` when never used.
    pub(crate) fn liability(env: &Env, token: &Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Liability(token.clone()))
            .unwrap_or(0)
    }

    pub(crate) fn add_liability(env: &Env, token: &Address, amount: i128) -> Result<(), Error> {
        let updated = Self::liability(env, token)
            .checked_add(amount)
            .ok_or(Error::Overflow)?;
        Self::set_liability(env, token, updated);
        Ok(())
    }

    pub(crate) fn sub_liability(env: &Env, token: &Address, amount: i128) -> Result<(), Error> {
        let updated = Self::liability(env, token)
            .checked_sub(amount)
            .ok_or(Error::Overflow)?;
        // The counter is the sum of `Funded` amounts, so it can never go
        // below zero; if it would, the accounting is broken and the whole
        // invocation must revert rather than record a negative liability.
        if updated < 0 {
            return Err(Error::Overflow);
        }
        Self::set_liability(env, token, updated);
        Ok(())
    }

    /// Writes the counter and keeps it from being archived (issue #10):
    /// the entry lives in persistent storage and its TTL is re-extended on
    /// every write, so a token with live escrows always has a live counter.
    pub(crate) fn set_liability(env: &Env, token: &Address, value: i128) {
        let key = DataKey::Liability(token.clone());
        let storage = env.storage().persistent();
        storage.set(&key, &value);
        let extend_to = LIABILITY_TTL_EXTEND_TO.min(env.storage().max_ttl());
        storage.extend_ttl(&key, LIABILITY_TTL_THRESHOLD.min(extend_to), extend_to);
    }

    pub(crate) fn vested_amount(total: i128, schedule: &VestingSchedule, now: u64) -> i128 {
        if now < schedule.start || schedule.cliff.is_some_and(|cliff| now < cliff) {
            return 0;
        }
        if now >= schedule.end {
            return total;
        }
        let duration = (schedule.end - schedule.start) as i128;
        let elapsed = (now - schedule.start) as i128;
        let whole = total / duration;
        let remainder = (total % duration) as u128;
        whole * elapsed + (remainder * elapsed as u128 / duration as u128) as i128
    }

    /// Extends the contract instance and code TTL if it is near expiry.
    pub(crate) fn extend_instance_ttl(env: &Env) {
        let extend_to = INSTANCE_EXTEND_TO.min(env.storage().max_ttl());
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD.min(extend_to), extend_to);
    }

    /// Extends an escrow entry to at least 180 days, or through its refund
    /// deadline plus a 30-day grace period, capped by the network maximum.
    pub(crate) fn extend_escrow_ttl(env: &Env, escrow_id: u64, refund_after: Option<u64>) {
        let deadline_target = refund_after.and_then(|deadline| {
            deadline
                .checked_sub(env.ledger().timestamp())
                .map(|seconds| {
                    let ledgers = u32::try_from(seconds / 5).unwrap_or(u32::MAX);
                    ledgers.saturating_add(ESCROW_GRACE_PERIOD_LEDGERS)
                })
        });
        let extend_to = deadline_target
            .unwrap_or(ESCROW_EXTEND_TO)
            .max(ESCROW_EXTEND_TO)
            .min(MAX_NETWORK_TTL_LEDGERS)
            .min(env.storage().max_ttl());
        let threshold = ESCROW_TTL_THRESHOLD.min(extend_to);
        let storage = env.storage().persistent();
        storage.extend_ttl(&DataKey::Escrow(escrow_id), threshold, extend_to);
        storage.extend_ttl(&DataKey::Status(escrow_id), threshold, extend_to);
    }
}
