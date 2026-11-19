//! `rotate_releaser`.

use crate::*;

#[contractimpl]
impl EscrowContract {
    /// Rotates a funded escrow's releaser. Both the current releaser and
    /// payer must authorize the change; the payer's consent prevents a
    /// compromised releaser from silently appointing an attacker. The
    /// replacement cannot be the contract itself or the payee.
    pub fn rotate_releaser(
        env: Env,
        escrow_id: u64,
        caller: Address,
        new_releaser: Address,
    ) -> Result<(), Error> {
        Self::extend_instance_ttl(&env);
        caller.require_auth();
        let mut data = Self::load(&env, escrow_id)?;

        if data.threshold != 1 {
            return Err(Error::ThresholdNotMet);
        }
        let previous_releaser = data.releasers.get(0).ok_or(Error::InvalidReleaser)?;
        if caller != previous_releaser {
            return Err(Error::Unauthorized);
        }
        if data.status != EscrowStatus::Funded {
            return Err(Error::NotFunded);
        }
        if new_releaser == env.current_contract_address() || new_releaser == data.payee {
            return Err(Error::InvalidReleaser);
        }

        data.payer.require_auth();
        let mut releasers = Vec::new(&env);
        releasers.push_back(new_releaser.clone());
        data.releasers = releasers;
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), &data);
        Self::extend_escrow_ttl(&env, escrow_id, data.refund_after);
        env.events().publish(
            (symbol_short!("rotate"), escrow_id),
            (previous_releaser, new_releaser),
        );
        Ok(())
    }
}
