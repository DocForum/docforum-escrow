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

    /// Read-only: the immutable token allowlist fixed at deployment
    /// (issue #299). An **empty** list means any token is accepted — the
    /// legacy behavior. Integrators should verify this on-chain instead of
    /// trusting deployment notes: there is no setter, so one read answers
    /// the question for the lifetime of the instance.
    ///
    /// Total by design: an instance whose allowlist key is absent returns
    /// an empty list rather than trapping. This WASM cannot reach that
    /// state (the constructor always writes the key), but a future
    /// migration or a differently-initialised instance can.
    pub fn get_allowed_tokens(env: Env) -> Vec<Address> {
        Self::extend_instance_ttl(&env);
        env.storage()
            .instance()
            .get(&DataKey::AllowedTokens)
            .unwrap_or_else(|| Vec::new(&env))
    }

    /// Semantic version of this contract interface and behavior.
    /// Build provenance is available separately in the WASM contract
    /// metadata (`git_sha` and `soroban_sdk_version`).
    pub fn version(env: Env) -> String {
        Self::extend_instance_ttl(&env);
        String::from_str(&env, CONTRACT_VERSION)
    }
}
