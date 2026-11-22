//! Emergency pause (docs/adr/0011).

use crate::*;

#[contractimpl]
impl EscrowContract {
    /// Blocks new deposits (`create_escrow` and its variants,
    /// `create_pooled_escrow`, `top_up` and `contribute`) until `unpause`
    /// is called. Callable only by the custodian
    /// set at deployment, which must sign this call (docs/adr/0011). Emits
    /// a `Paused` event carrying that address.
    ///
    /// Deliberately has no effect on money already escrowed: `release`,
    /// `refund`, the timeout refund and `claim_refund` do not read the
    /// flag, so a pause can never lock existing funds. Errors
    /// `AlreadyPaused` if the contract is already paused.
    pub fn pause(env: Env, caller: Address) -> Result<(), Error> {
        caller.require_auth();
        Self::require_pause_admin(&env, &caller)?;
        if Self::is_paused(env.clone()) {
            return Err(Error::AlreadyPaused);
        }

        env.storage().instance().set(&DataKey::Paused, &true);
        Paused { admin: caller }.publish(&env);
        Ok(())
    }

    /// Re-opens new deposits. Same auth as `pause` — only the custodian
    /// set at deployment. Emits an `Unpaused` event. Errors `NotPaused` if
    /// the contract isn't paused.
    ///
    /// Unpausing is not timelocked on purpose (docs/adr/0011): it restores
    /// normal operation and cannot touch a single escrow, so delaying it
    /// would only delay recovery.
    pub fn unpause(env: Env, caller: Address) -> Result<(), Error> {
        caller.require_auth();
        Self::require_pause_admin(&env, &caller)?;
        if !Self::is_paused(env.clone()) {
            return Err(Error::NotPaused);
        }

        env.storage().instance().set(&DataKey::Paused, &false);
        Unpaused { admin: caller }.publish(&env);
        Ok(())
    }

    /// Read-only: is the emergency pause currently blocking new deposits?
    /// Says nothing about existing escrows — `release`/`refund` work either
    /// way (docs/adr/0011).
    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    /// Read-only: the custodian address that may `pause`/`unpause`, so
    /// integrators can verify who holds the role without trusting docs
    /// (docs/adr/0011). `None` only for an instance deployed without a
    /// constructor, which this contract's WASM does not allow.
    pub fn get_pause_admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::PauseAdmin)
    }

    pub(crate) fn require_pause_admin(env: &Env, caller: &Address) -> Result<(), Error> {
        let admin: Option<Address> = env.storage().instance().get(&DataKey::PauseAdmin);
        match admin {
            Some(admin) if &admin == caller => Ok(()),
            _ => Err(Error::Unauthorized),
        }
    }
}
