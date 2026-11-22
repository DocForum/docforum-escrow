//! Split settlement (`settle`).

use crate::*;

#[contractimpl]
impl EscrowContract {
    /// Pays `payee_amount` of a funded escrow to its payee and returns the rest
    /// to its refund destination (`refund_to`, the payer unless set at creation).
    /// A single releaser authorizes the split; quorum escrows must use the
    /// approval path. Applies the same release-time and acceptance gates as
    /// `release`, so a split can never bypass them. `payee_amount` is gross:
    /// a protocol fee, if set, comes out of the payee's share only and the
    /// refunded part is never charged (docs/adr/0010). Streamed and
    /// multi-payee escrows answer `SettlementNotSupported`.
    pub fn settle(
        env: Env,
        escrow_id: u64,
        caller: Address,
        payee_amount: i128,
    ) -> Result<(), Error> {
        caller.require_auth();
        let mut data = Self::load(&env, escrow_id)?;
        Self::check_single_caller(&data, &caller)?;
        Self::reject_pooled(&env, escrow_id)?;
        Self::check_funded(&data)?;
        if env
            .storage()
            .persistent()
            .has(&DataKey::Milestones(escrow_id))
        {
            return Err(Error::MilestoneReleaseRequired);
        }
        if data.payees.len() > 1 || env.storage().persistent().has(&DataKey::Vesting(escrow_id)) {
            return Err(Error::SettlementNotSupported);
        }
        if payee_amount < 0 || payee_amount > data.amount {
            return Err(Error::InvalidSettlementAmount);
        }
        // The protocol fee is taken on release, never on refund (docs/adr/0010).
        // A split settlement is part release, part refund, so the fee applies to
        // the payee's share only: settle(0) behaves like `refund` and
        // settle(amount) like `release`.
        let fee = match (data.fee_recipient.as_ref(), data.fee_bps) {
            (Some(_), Some(bps)) if payee_amount > 0 => Self::fee_amount(payee_amount, bps)?,
            _ => 0,
        };
        let payer_amount = data.amount - payee_amount;
        let payee_amount = payee_amount - fee;
        if data
            .release_not_before
            .is_some_and(|release_time| env.ledger().timestamp() < release_time)
        {
            return Err(Error::ReleaseTooEarly);
        }
        if data.requires_acceptance && data.accepted_at.is_none() {
            return Err(Error::AcceptanceRequired);
        }
        let refund_to = data.refund_to.clone();
        let notify_payee = data.notify_payee && payee_amount > 0;

        data.status = EscrowStatus::Released;
        // Reclaim storage like every other settlement (docs/adr/0013): only
        // the `Status` entry remains. `settle` rejects pooled escrows, so
        // there is no pooled record to keep.
        env.storage()
            .persistent()
            .remove(&DataKey::Escrow(escrow_id));
        env.storage()
            .persistent()
            .set(&DataKey::Status(escrow_id), &data.status);
        Self::sub_liability(&env, &data.token, data.amount)?;
        Self::extend_instance_ttl(&env);
        env.storage().persistent().extend_ttl(
            &DataKey::Status(escrow_id),
            SETTLED_ESCROW_TTL_THRESHOLD,
            SETTLED_ESCROW_EXTEND_TO,
        );
        let token_client = token::Client::new(&env, &data.token);
        let contract_address = env.current_contract_address();
        if fee > 0 {
            if let Some(recipient) = data.fee_recipient.as_ref() {
                let transfer = token_client.try_transfer(&contract_address, recipient, &fee);
                if !matches!(transfer, Ok(Ok(()))) {
                    return Err(Error::Undeliverable);
                }
            }
        }
        if payee_amount > 0 {
            let transfer = token_client.try_transfer(&contract_address, &data.payee, &payee_amount);
            if !matches!(transfer, Ok(Ok(()))) {
                return Err(Error::Undeliverable);
            }
        }
        if payer_amount > 0 {
            let transfer = token_client.try_transfer(&contract_address, &refund_to, &payer_amount);
            if !matches!(transfer, Ok(Ok(()))) {
                return Err(Error::Undeliverable);
            }
        }
        if notify_payee {
            let args = (escrow_id, payee_amount).into_val(&env);
            let callback = env.try_invoke_contract::<(), soroban_sdk::Error>(
                &data.payee,
                &soroban_sdk::Symbol::new(&env, "on_escrow_released"),
                args,
            );
            match callback {
                Ok(Ok(())) => {}
                _ => return Err(Error::CallbackFailed),
            }
        }
        env.events().publish(
            (symbol_short!("settled"), escrow_id),
            (payee_amount, payer_amount),
        );
        Ok(())
    }
}
