#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, xdr::ToXdr, Address, BytesN, Env, Symbol,
};

#[contracttype]
#[derive(Clone)]
enum DataKey {
    EscrowWasmHash,
    Instance(Address),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyDeployed = 1,
}

/// Deploys one immutable-code escrow instance for each integrator.
/// The factory retains only the escrow WASM hash and public registry; it has
/// no administrative or upgrade path into the instances it creates.
#[contract]
pub struct EscrowFactory;

#[contractimpl]
impl EscrowFactory {
    /// Pins the escrow implementation hash for this factory deployment.
    pub fn __constructor(env: Env, escrow_wasm_hash: BytesN<32>) {
        env.storage()
            .instance()
            .set(&DataKey::EscrowWasmHash, &escrow_wasm_hash);
    }

    /// Deploys the integrator's isolated escrow instance. The integrator signs
    /// the request; its XDR value is domain-separated and hashed into a stable
    /// salt scoped to this factory address.
    pub fn create_instance(env: Env, integrator: Address) -> Result<Address, Error> {
        integrator.require_auth();

        let registry_key = DataKey::Instance(integrator.clone());
        if env.storage().persistent().has(&registry_key) {
            return Err(Error::AlreadyDeployed);
        }

        let salt_input = (Symbol::new(&env, "DOCFORUM_ESCROW_V1"), integrator.clone()).to_xdr(&env);
        let salt = env.crypto().sha256(&salt_input).to_bytes();
        let wasm_hash: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::EscrowWasmHash)
            .expect("escrow WASM hash is initialized by the constructor");
        let instance = env
            .deployer()
            .with_current_contract(salt)
            .deploy_v2(wasm_hash, (integrator.clone(),));

        env.storage().persistent().set(&registry_key, &instance);
        Ok(instance)
    }

    /// Predicts the deterministic address for an integrator without deploying.
    pub fn predict_instance(env: Env, integrator: Address) -> Address {
        let salt_input = (Symbol::new(&env, "DOCFORUM_ESCROW_V1"), integrator).to_xdr(&env);
        let salt = env.crypto().sha256(&salt_input).to_bytes();
        env.deployer()
            .with_current_contract(salt)
            .deployed_address()
    }

    /// Returns the registered instance, or `None` before deployment.
    pub fn get_instance(env: Env, integrator: Address) -> Option<Address> {
        env.storage()
            .persistent()
            .get(&DataKey::Instance(integrator))
    }
}
