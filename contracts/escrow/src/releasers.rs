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

    /// Rotates one member of an M-of-N releaser set (issue #294, ADR 0009).
    /// The escrow must be `Funded`. At least `threshold` distinct members
    /// of the current set must authorize this exact invocation
    /// (`check_approvals`), and the stored payer must authorize too — the
    /// payer's consent is the recovery guard, as in single rotation.
    ///
    /// The outgoing member's approval counts toward the threshold: it is
    /// still a member until the rotation lands, and excluding it would
    /// make recovery impossible when only `threshold` members can sign.
    /// If the payer is also a releaser, one signature satisfies both
    /// roles. The set size and threshold are unchanged, so
    /// `threshold <= releasers.len()` keeps holding. `old` must be a
    /// current member; `new` must not already be a member, must not be
    /// the contract itself, and must not be the payee. Emits the same
    /// `rotate` event as single rotation, carrying old and new.
    pub fn rotate_releaser_with_approvals(
        env: Env,
        escrow_id: u64,
        approvers: Vec<Address>,
        old_releaser: Address,
        new_releaser: Address,
    ) -> Result<(), Error> {
        Self::extend_instance_ttl(&env);
        let mut data = Self::load(&env, escrow_id)?;
        Self::check_approvals(&env, &data, &approvers)?;
        Self::check_funded(&data)?;
        if !Self::contains(&data.releasers, &old_releaser) {
            return Err(Error::InvalidReleaser);
        }
        if Self::contains(&data.releasers, &new_releaser)
            || new_releaser == env.current_contract_address()
            || new_releaser == data.payee
        {
            return Err(Error::InvalidReleaser);
        }

        data.payer.require_auth();
        let mut releasers = Vec::new(&env);
        for releaser in data.releasers.iter() {
            if releaser == old_releaser {
                releasers.push_back(new_releaser.clone());
            } else {
                releasers.push_back(releaser);
            }
        }
        data.releasers = releasers;
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), &data);
        Self::extend_escrow_ttl(&env, escrow_id, data.refund_after);
        env.events().publish(
            (symbol_short!("rotate"), escrow_id),
            (old_releaser, new_releaser),
        );
        Ok(())
    }
}
