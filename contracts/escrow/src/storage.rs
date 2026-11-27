//! Ids, token transfers, liabilities, vesting math and TTL helpers.

use crate::*;

impl EscrowContract {
    /// Allocates the next escrow id. The counter is a `u64` that grows by
    /// one per escrow, so exhausting it is unreachable in practice; it is
    /// still checked so the invocation fails with `Overflow` instead of a
    /// host panic.
    pub(crate) fn next_id(env: &Env) -> Result<u64, Error> {
        let id: u64 = env.storage().instance().get(&DataKey::NextId).unwrap_or(0);
        let next = id.checked_add(1).ok_or(Error::Overflow)?;
        env.storage().instance().set(&DataKey::NextId, &next);
        Ok(id)
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
        Self::add_liability(env, token, amount)?;
        Ok(())
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
        Self::add_liability(env, token, amount)?;
        Ok(())
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

    /// Linear vesting: `floor(total * elapsed / duration)`, computed without
    /// the `total * elapsed` intermediate (which could exceed `i128`) by
    /// splitting `total = whole * duration + remainder`:
    /// `whole * elapsed + floor(remainder * elapsed / duration)`. The split
    /// is exact, not an approximation, so the result never exceeds `total`.
    /// Creation guarantees `start < end`, and `start <= now < end` here, so
    /// none of the checked operations can fail on a valid schedule; they
    /// return `Overflow` rather than panic if the invariant is ever broken.
    ///
    /// Scout's `divide-before-multiply` fires on this split; it is a false
    /// positive because the identity is exact (docs/supply-chain.md, Scout
    /// findings triage).
    #[allow(unknown_lints, divide_before_multiply)]
    pub(crate) fn vested_amount(
        total: i128,
        schedule: &VestingSchedule,
        now: u64,
    ) -> Result<i128, Error> {
        if now < schedule.start || schedule.cliff.is_some_and(|cliff| now < cliff) {
            return Ok(0);
        }
        if now >= schedule.end {
            return Ok(total);
        }
        let duration = schedule
            .end
            .checked_sub(schedule.start)
            .ok_or(Error::Overflow)?;
        let elapsed = now.checked_sub(schedule.start).ok_or(Error::Overflow)?;
        let duration_wide = i128::from(duration);
        let whole = total.checked_div(duration_wide).ok_or(Error::Overflow)?;
        // `remainder < duration <= u64::MAX` and `elapsed < u64::MAX`, so the
        // product fits in `u128`.
        let remainder = u128::try_from(total.checked_rem(duration_wide).ok_or(Error::Overflow)?)
            .map_err(|_| Error::Overflow)?;
        let fraction = remainder
            .checked_mul(u128::from(elapsed))
            .and_then(|scaled| scaled.checked_div(u128::from(duration)))
            .and_then(|fraction| i128::try_from(fraction).ok())
            .ok_or(Error::Overflow)?;
        whole
            .checked_mul(i128::from(elapsed))
            .and_then(|vested| vested.checked_add(fraction))
            .ok_or(Error::Overflow)
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

    pub(crate) fn extend_unique_ref_ttl(env: &Env, key: &DataKey, refund_after: Option<u64>) {
        let deadline_target = refund_after.and_then(|deadline| {
            deadline
                .checked_sub(env.ledger().timestamp())
                .map(|seconds| {
                    u32::try_from(seconds / 5)
                        .unwrap_or(u32::MAX)
                        .saturating_add(ESCROW_GRACE_PERIOD_LEDGERS)
                })
        });
        let extend_to = deadline_target
            .unwrap_or(ESCROW_EXTEND_TO)
            .max(ESCROW_EXTEND_TO)
            .min(MAX_NETWORK_TTL_LEDGERS)
            .min(env.storage().max_ttl());
        let threshold = ESCROW_TTL_THRESHOLD.min(extend_to);
        env.storage()
            .persistent()
            .extend_ttl(key, threshold, extend_to);
    }
}

#[cfg(test)]
mod vested_amount_tests {
    use super::*;

    fn schedule(start: u64, end: u64, cliff: Option<u64>) -> VestingSchedule {
        VestingSchedule { start, end, cliff }
    }

    #[test]
    fn matches_the_direct_formula_for_normal_amounts() {
        let stream = schedule(100, 1_100, None);
        for total in [1, 7, 999, 1_000, 1_001, 123_456_789, i128::from(i64::MAX)] {
            for now in 100..1_100 {
                let direct = total * i128::from(now - 100) / 1_000;
                assert_eq!(
                    EscrowContract::vested_amount(total, &stream, now),
                    Ok(direct),
                    "total {total}, now {now}"
                );
            }
        }
    }

    #[test]
    fn boundaries_and_cliff() {
        let stream = schedule(10, 20, Some(15));
        assert_eq!(EscrowContract::vested_amount(100, &stream, 0), Ok(0));
        assert_eq!(EscrowContract::vested_amount(100, &stream, 14), Ok(0));
        assert_eq!(EscrowContract::vested_amount(100, &stream, 15), Ok(50));
        assert_eq!(EscrowContract::vested_amount(100, &stream, 20), Ok(100));
        assert_eq!(
            EscrowContract::vested_amount(100, &stream, u64::MAX),
            Ok(100)
        );
    }

    #[test]
    fn is_exact_where_the_direct_product_would_overflow() {
        // `i128::MAX * elapsed` overflows; halfway through an even-length
        // stream the exact answer is `floor(total / 2)`.
        let wide = schedule(0, u64::MAX - 1, None);
        let half = (u64::MAX - 1) / 2;
        assert_eq!(
            EscrowContract::vested_amount(i128::MAX, &wide, half),
            Ok(i128::MAX / 2)
        );
        assert_eq!(
            EscrowContract::vested_amount(i128::MAX, &wide, u64::MAX - 2),
            Ok(i128::MAX - i128::MAX / i128::from(u64::MAX - 1) - 1)
        );
        // Every point of a three-second stream of `i128::MAX`, exactly:
        // `i128::MAX = 3k + 1`, so a third floors to `k` and two thirds to
        // `2k = i128::MAX - k - 1`. Monotone and never above the total.
        let short = schedule(0, 3, None);
        let third = i128::MAX / 3;
        let expected = [0, third, i128::MAX - third - 1, i128::MAX];
        for (now, want) in (0u64..).zip(expected) {
            assert_eq!(
                EscrowContract::vested_amount(i128::MAX, &short, now),
                Ok(want)
            );
        }
    }
}
