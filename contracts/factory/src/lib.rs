#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, crypto::Hash, xdr::ToXdr, Address, BytesN,
    Env, Vec,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    AlreadyRegistered = 1,
}

#[contracttype]
pub enum DataKey {
    EscrowWasm,
    Instance(Address),
}

/// Deploys isolated escrow instances. The factory stores no instance admin:
/// the constructor configuration is passed once and every later operation is
/// performed directly against the deployed escrow contract.
#[contract]
pub struct EscrowFactory;

#[contractimpl]
impl EscrowFactory {
    pub fn __constructor(env: Env, escrow_wasm: BytesN<32>) {
        env.storage()
            .instance()
            .set(&DataKey::EscrowWasm, &escrow_wasm);
    }

    pub fn create_instance(
        env: Env,
        integrator: Address,
        salt: BytesN<32>,
        allowed_tokens: Vec<Address>,
        pause_admin: Address,
    ) -> Result<Address, Error> {
        integrator.require_auth();
        if env
            .storage()
            .persistent()
            .has(&DataKey::Instance(integrator.clone()))
        {
            return Err(Error::AlreadyRegistered);
        }
        let wasm_hash: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::EscrowWasm)
            .expect("factory was not initialized");
        let mut preimage = integrator.clone().to_xdr(&env);
        preimage.append(&salt.to_xdr(&env));
        let derived_salt: Hash<32> = env.crypto().sha256(&preimage);
        let instance = env
            .deployer()
            .with_current_contract(derived_salt)
            .deploy_v2(wasm_hash, (allowed_tokens, pause_admin));
        env.storage()
            .persistent()
            .set(&DataKey::Instance(integrator), &instance);
        Ok(instance)
    }

    pub fn get_instance(env: Env, integrator: Address) -> Option<Address> {
        env.storage()
            .persistent()
            .get(&DataKey::Instance(integrator))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, BytesN};

    #[test]
    fn registry_is_empty_before_deployment() {
        let env = Env::default();
        let factory = env.register(EscrowFactory, (BytesN::from_array(&env, &[7; 32]),));
        let client = EscrowFactoryClient::new(&env, &factory);
        assert!(client.get_instance(&Address::generate(&env)).is_none());
    }
}
