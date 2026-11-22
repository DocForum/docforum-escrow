//! Fixed, independently releasable escrow tranches (issue #21).

use crate::*;

#[contractimpl]
impl EscrowContract {
    /// Releases one unreleased tranche. Tranches may be released in any
    /// order; the escrow remains funded until the final tranche is paid.
    pub fn release_milestone(
        env: Env,
        escrow_id: u64,
        index: u32,
        caller: Address,
    ) -> Result<(), Error> {
        Self::extend_instance_ttl(&env);
        caller.require_auth();

        let mut data = Self::load(&env, escrow_id)?;
        Self::check_single_caller(&data, &caller)?;
        Self::check_funded(&data)?;
        if env.storage().persistent().has(&DataKey::Pooled(escrow_id)) {
            return Err(Error::NotSupportedForPooled);
        }
        let mut milestones: MilestoneData = env
            .storage()
            .persistent()
            .get(&DataKey::Milestones(escrow_id))
            .ok_or(Error::NotMilestone)?;
        if index >= milestones.amounts.len() {
            return Err(Error::InvalidMilestoneIndex);
        }
        if milestones.released.get(index).unwrap_or(false) {
            return Err(Error::MilestoneAlreadyReleased);
        }
        if data
            .release_not_before
            .is_some_and(|release_time| env.ledger().timestamp() < release_time)
        {
            return Err(Error::ReleaseTooEarly);
        }
        if data.requires_acceptance && data.accepted_at.is_none() {
            return Err(Error::AcceptanceRequired);
        }

        let tranche = milestones
            .amounts
            .get(index)
            .ok_or(Error::InvalidMilestoneIndex)?;
        let paid = milestones
            .paid
            .checked_add(tranche)
            .ok_or(Error::Overflow)?;
        if paid > data.amount {
            return Err(Error::InvalidMilestones);
        }
        let final_tranche = paid == data.amount;
        milestones.released.set(index, true);
        milestones.paid = paid;

        // Persist the one-time claim and reduce outstanding liability before
        // calling the token or payee. Host rollback keeps failures atomic.
        env.storage()
            .persistent()
            .set(&DataKey::Milestones(escrow_id), &milestones);
        Self::sub_liability(&env, &data.token, tranche)?;
        if final_tranche {
            data.status = EscrowStatus::Released;
            env.storage()
                .persistent()
                .set(&DataKey::Status(escrow_id), &data.status);
            env.storage()
                .persistent()
                .remove(&DataKey::Escrow(escrow_id));
            env.storage().persistent().extend_ttl(
                &DataKey::Status(escrow_id),
                SETTLED_ESCROW_TTL_THRESHOLD,
                SETTLED_ESCROW_EXTEND_TO,
            );
            Self::extend_settled_milestone_ttl(&env, escrow_id);
            Self::publish_state(&env, symbol_short!("released"), escrow_id, &data);
        } else {
            Self::extend_escrow_ttl(&env, escrow_id, data.refund_after);
        }

        let fee = match (data.fee_recipient.as_ref(), data.fee_bps) {
            (Some(_), Some(bps)) => Self::fee_amount(tranche, bps)?,
            _ => 0,
        };
        let payout = tranche.checked_sub(fee).ok_or(Error::Overflow)?;
        let token = token::Client::new(&env, &data.token);
        let contract = env.current_contract_address();
        if fee > 0 {
            if let Some(recipient) = data.fee_recipient.as_ref() {
                if !matches!(token.try_transfer(&contract, recipient, &fee), Ok(Ok(()))) {
                    return Err(Error::Undeliverable);
                }
            }
        }
        if payout > 0
            && !matches!(
                token.try_transfer(&contract, &data.payee, &payout),
                Ok(Ok(()))
            )
        {
            return Err(Error::Undeliverable);
        }
        if data.notify_payee {
            let args = (escrow_id, payout).into_val(&env);
            let callback = env.try_invoke_contract::<(), soroban_sdk::Error>(
                &data.payee,
                &soroban_sdk::Symbol::new(&env, "on_escrow_released"),
                args,
            );
            if !matches!(callback, Ok(Ok(()))) {
                return Err(Error::CallbackFailed);
            }
        }
        env.events().publish(
            (symbol_short!("milestone"), escrow_id),
            (index, tranche, paid),
        );
        Ok(())
    }

    /// Refunds only the original amount that has not already been released.
    pub(crate) fn refund_milestones(
        env: &Env,
        escrow_id: u64,
        data: &mut EscrowData,
    ) -> Result<(), Error> {
        let milestones: MilestoneData = env
            .storage()
            .persistent()
            .get(&DataKey::Milestones(escrow_id))
            .ok_or(Error::NotMilestone)?;
        let remaining = data
            .amount
            .checked_sub(milestones.paid)
            .ok_or(Error::Overflow)?;
        if remaining <= 0 {
            return Err(Error::NotFunded);
        }

        data.amount = remaining;
        data.status = EscrowStatus::Refunded;
        env.storage()
            .persistent()
            .set(&DataKey::Status(escrow_id), &data.status);
        env.storage()
            .persistent()
            .remove(&DataKey::Escrow(escrow_id));
        Self::sub_liability(env, &data.token, remaining)?;
        env.storage().persistent().extend_ttl(
            &DataKey::Status(escrow_id),
            SETTLED_ESCROW_TTL_THRESHOLD,
            SETTLED_ESCROW_EXTEND_TO,
        );
        Self::extend_settled_milestone_ttl(env, escrow_id);
        Self::publish_state(env, symbol_short!("refunded"), escrow_id, data);

        let token = token::Client::new(env, &data.token);
        if !matches!(
            token.try_transfer(&env.current_contract_address(), &data.refund_to, &remaining),
            Ok(Ok(()))
        ) {
            return Err(Error::Undeliverable);
        }
        Ok(())
    }
}
