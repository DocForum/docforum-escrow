//! `top_up`.

use crate::*;

#[contractimpl]
impl EscrowContract {
    /// Adds funds to a funded escrow without changing its parties or id.
    /// Only its original payer may authorize the transfer.
    pub fn top_up(env: Env, escrow_id: u64, payer: Address, amount: i128) -> Result<(), Error> {
        Self::extend_instance_ttl(&env);
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        // `top_up` is a deposit path, so the emergency pause gates it too
        // (docs/adr/0011): paused blocks every way new money enters, and
        // nothing else.
        if Self::is_paused(env.clone()) {
            return Err(Error::Paused);
        }
        payer.require_auth();
        let mut data = Self::load(&env, escrow_id)?;
        // A pooled escrow grows only through `contribute`, which records
        // the payer and verifies the received amount (docs/adr/0011).
        // A bare top-up would raise `data.amount` without a contribution
        // record, breaking "funded == sum of unclaimed contributions".
        Self::reject_pooled(&env, escrow_id)?;
        if env.storage().persistent().has(&DataKey::Vesting(escrow_id)) {
            return Err(Error::StreamTopUpUnsupported);
        }
        if data.payer != payer {
            return Err(Error::Unauthorized);
        }
        if data.status != EscrowStatus::Funded {
            return Err(Error::NotFunded);
        }
        let updated_amount = data.amount.checked_add(amount).ok_or(Error::Overflow)?;
        Self::check_amount_cap(&env, &data.token, updated_amount)?;
        // The fee is a bps of the escrowed amount, so a top-up grows it; fail
        // now (before the transfer) if the larger amount would overflow the
        // fee math, rather than at release (docs/adr/0010).
        if let Some(bps) = data.fee_bps {
            Self::fee_amount(updated_amount, bps)?;
        }
        Self::transfer_in_exact(&env, &data.token, &payer, amount)?;
        data.amount = updated_amount;
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), &data);
        Self::extend_escrow_ttl(&env, escrow_id, data.refund_after);
        env.events().publish(
            (symbol_short!("top_up"), escrow_id),
            (amount, updated_amount),
        );
        Ok(())
    }
}
