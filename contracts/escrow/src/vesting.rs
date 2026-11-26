//! Linear vesting streams: `get_vesting` and `withdraw`.

use crate::*;

#[contractimpl]
impl EscrowContract {
    /// Returns current vested, withdrawn, and claimable amounts for a stream.
    pub fn get_vesting(env: Env, escrow_id: u64) -> Result<VestingInfo, Error> {
        // A settled stream's record is reclaimed (docs/adr/0013); its schedule
        // and withdrawal totals live in their own entries and stay readable.
        let funded = match Self::read_escrow(&env, escrow_id) {
            Some(data) => data.status == EscrowStatus::Funded,
            None if env.storage().persistent().has(&DataKey::Status(escrow_id)) => false,
            None => return Err(Error::NotFound),
        };
        let schedule: VestingSchedule = env
            .storage()
            .persistent()
            .get(&DataKey::Vesting(escrow_id))
            .ok_or(Error::NotStreamed)?;
        let withdrawn: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::Withdrawn(escrow_id))
            .unwrap_or(0);
        let total: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::TotalAmount(escrow_id))
            .ok_or(Error::NotStreamed)?;
        let vested = Self::vested_amount(total, &schedule, env.ledger().timestamp());
        let claimable = if funded {
            vested.saturating_sub(withdrawn)
        } else {
            0
        };
        Ok(VestingInfo {
            schedule,
            total_amount: total,
            vested_amount: vested,
            withdrawn_amount: withdrawn,
            claimable_amount: claimable,
        })
    }

    /// Transfers vested tokens to the payee and reduces the remaining
    /// escrow amount and per-token liability by the same amount.
    pub fn withdraw(env: Env, escrow_id: u64, payee: Address) -> Result<i128, Error> {
        payee.require_auth();
        let mut data = Self::load(&env, escrow_id)?;
        Self::check_funded(&data)?;
        if payee != data.payee {
            return Err(Error::Unauthorized);
        }
        let schedule: VestingSchedule = env
            .storage()
            .persistent()
            .get(&DataKey::Vesting(escrow_id))
            .ok_or(Error::NotStreamed)?;
        let withdrawn: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::Withdrawn(escrow_id))
            .unwrap_or(0);
        let total: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::TotalAmount(escrow_id))
            .ok_or(Error::NotStreamed)?;
        let claimable = Self::vested_amount(total, &schedule, env.ledger().timestamp())
            .saturating_sub(withdrawn);
        if claimable <= 0 {
            return Err(Error::NothingToWithdraw);
        }
        if claimable > data.amount {
            return Err(Error::Overflow);
        }
        let contract_address = env.current_contract_address();
        let token_client = token::Client::new(&env, &data.token);
        if token_client.balance(&contract_address) < claimable {
            return Err(Error::PoolInsufficient);
        }
        let updated_withdrawn = withdrawn.checked_add(claimable).ok_or(Error::Overflow)?;
        data.amount = data.amount.checked_sub(claimable).ok_or(Error::Overflow)?;
        Self::write_escrow(&env, escrow_id, &data);
        env.storage()
            .persistent()
            .set(&DataKey::Withdrawn(escrow_id), &updated_withdrawn);
        Self::sub_liability(&env, &data.token, claimable)?;
        token_client.transfer(&contract_address, &payee, &claimable);
        Ok(claimable)
    }
}
