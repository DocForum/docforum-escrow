//! Constructor and `version`.

use crate::*;

#[contractimpl]
impl EscrowContract {
    /// Sets the immutable token allowlist at deployment. An empty list
    /// preserves the legacy behavior and allows any token address.
    ///
    /// Also stores the single address permitted to `pause`/`unpause`
    /// (docs/adr/0011). There is no setter, so the custodian cannot be
    /// changed after deployment — a new custodian means a new deployment.
    /// No auth is required here: the constructor runs as part of deploying
    /// the instance, before any caller exists.
    ///
    /// The custodian is deliberately weak: its only power is to refuse
    /// **new** deposits. It cannot release, refund, edit an escrow, or
    /// upgrade anything.
    pub fn __constructor(env: Env, allowed_tokens: Vec<Address>, pause_admin: Address) {
        env.storage()
            .instance()
            .set(&DataKey::AllowedTokens, &allowed_tokens);
        Self::extend_instance_ttl(&env);
        env.storage()
            .instance()
            .set(&DataKey::PauseAdmin, &pause_admin);
        env.storage().instance().set(&DataKey::Paused, &false);
    }

    /// Semantic version of this contract interface and behavior.
    /// Build provenance is available separately in the WASM contract
    /// metadata (`git_sha` and `soroban_sdk_version`).
    pub fn version(env: Env) -> String {
        Self::extend_instance_ttl(&env);
        String::from_str(&env, CONTRACT_VERSION)
    }
}
