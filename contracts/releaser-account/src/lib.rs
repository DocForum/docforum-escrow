#![no_std]

use soroban_sdk::{
    auth::{Context, CustomAccountInterface},
    contract, contracterror, contractimpl, contracttype,
    crypto::Hash,
    symbol_short, Address, Bytes, BytesN, Env, Symbol, TryFromVal, Val, Vec,
};

const MAX_SIGNERS: u32 = 20;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SignerSignature {
    pub public_key: BytesN<32>,
    pub signature: BytesN<64>,
}

/// A signer-management operation. Its signed digest includes this account's
/// address and current management nonce.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ManagementAction {
    AddSigner(BytesN<32>),
    RemoveSigner(BytesN<32>),
    SetThreshold(u32),
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Escrow,
    Threshold,
    Signer(BytesN<32>),
    SignerCount,
    ManagementNonce,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    InvalidConfiguration = 1,
    InvalidSignerSet = 2,
    InvalidThreshold = 3,
    UnauthorizedContext = 4,
    InvalidSignature = 5,
    SignerAlreadyExists = 6,
    UnknownSigner = 7,
    CannotRemoveBelowThreshold = 8,
}

#[contract]
pub struct ReleaserAccount;

#[contractimpl]
impl ReleaserAccount {
    /// Initializes an immutable escrow target and an M-of-N Ed25519 signer set.
    pub fn __constructor(env: Env, escrow: Address, signers: Vec<BytesN<32>>, threshold: u32) {
        if signers.is_empty()
            || signers.len() > MAX_SIGNERS
            || threshold == 0
            || threshold > signers.len()
        {
            env.panic_with_error(Error::InvalidConfiguration);
        }
        for i in 0..signers.len() {
            let key = signers.get(i).unwrap();
            for prior_index in 0..i {
                if signers.get(prior_index).unwrap() == key {
                    env.panic_with_error(Error::InvalidSignerSet);
                }
            }
            env.storage().persistent().set(&DataKey::Signer(key), &true);
        }
        env.storage().persistent().set(&DataKey::Escrow, &escrow);
        env.storage()
            .persistent()
            .set(&DataKey::Threshold, &threshold);
        env.storage()
            .persistent()
            .set(&DataKey::SignerCount, &signers.len());
        env.storage()
            .persistent()
            .set(&DataKey::ManagementNonce, &0u64);
    }

    pub fn escrow(env: Env) -> Address {
        get(&env, &DataKey::Escrow)
    }

    pub fn threshold(env: Env) -> u32 {
        get(&env, &DataKey::Threshold)
    }

    pub fn signer_count(env: Env) -> u32 {
        get(&env, &DataKey::SignerCount)
    }

    pub fn management_nonce(env: Env) -> u64 {
        get(&env, &DataKey::ManagementNonce)
    }

    /// Returns the exact digest the current threshold must sign for the next
    /// management operation. The advancing nonce prevents replay.
    pub fn management_payload(env: Env, action: ManagementAction) -> BytesN<32> {
        management_digest(&env, &action, get(&env, &DataKey::ManagementNonce)).to_bytes()
    }

    /// Adds/removes a signer or changes M after verifying the current quorum.
    pub fn manage(
        env: Env,
        action: ManagementAction,
        signatures: Vec<SignerSignature>,
    ) -> Result<(), Error> {
        let digest =
            management_digest(&env, &action, get(&env, &DataKey::ManagementNonce)).to_bytes();
        verify_signatures(
            &env,
            &digest,
            &signatures,
            get(&env, &DataKey::Threshold),
            get(&env, &DataKey::SignerCount),
        )?;

        match action {
            ManagementAction::AddSigner(public_key) => {
                let count = get::<u32>(&env, &DataKey::SignerCount);
                if count >= MAX_SIGNERS {
                    return Err(Error::InvalidSignerSet);
                }
                if is_signer(&env, &public_key) {
                    return Err(Error::SignerAlreadyExists);
                }
                env.storage()
                    .persistent()
                    .set(&DataKey::Signer(public_key), &true);
                env.storage()
                    .persistent()
                    .set(&DataKey::SignerCount, &(count + 1));
            }
            ManagementAction::RemoveSigner(public_key) => {
                if !is_signer(&env, &public_key) {
                    return Err(Error::UnknownSigner);
                }
                let count = get::<u32>(&env, &DataKey::SignerCount);
                let threshold = get::<u32>(&env, &DataKey::Threshold);
                if count <= threshold {
                    return Err(Error::CannotRemoveBelowThreshold);
                }
                env.storage()
                    .persistent()
                    .remove(&DataKey::Signer(public_key));
                env.storage()
                    .persistent()
                    .set(&DataKey::SignerCount, &(count - 1));
            }
            ManagementAction::SetThreshold(threshold) => {
                let count = get::<u32>(&env, &DataKey::SignerCount);
                if threshold == 0 || threshold > count {
                    return Err(Error::InvalidThreshold);
                }
                env.storage()
                    .persistent()
                    .set(&DataKey::Threshold, &threshold);
            }
        }

        let nonce = get::<u64>(&env, &DataKey::ManagementNonce);
        env.storage()
            .persistent()
            .set(&DataKey::ManagementNonce, &(nonce + 1));
        Ok(())
    }
}

#[contractimpl]
impl CustomAccountInterface for ReleaserAccount {
    type Signature = Vec<SignerSignature>;
    type Error = Error;

    fn __check_auth(
        env: Env,
        signature_payload: Hash<32>,
        signatures: Self::Signature,
        auth_contexts: Vec<Context>,
    ) -> Result<(), Error> {
        let escrow: Address = get(&env, &DataKey::Escrow);
        if !release_or_refund_only(&env, &escrow, &auth_contexts) {
            return Err(Error::UnauthorizedContext);
        }
        let payload = signature_payload.to_bytes();
        verify_signatures(
            &env,
            &payload,
            &signatures,
            get(&env, &DataKey::Threshold),
            get(&env, &DataKey::SignerCount),
        )
    }
}

fn release_or_refund_only(env: &Env, escrow: &Address, contexts: &Vec<Context>) -> bool {
    // One account auth entry authorizes one escrow operation. Additional or
    // nested auth contexts are rejected rather than implicitly covered.
    if contexts.len() != 1 {
        return false;
    }
    let Some(Context::Contract(context)) = contexts.first() else {
        return false;
    };
    if context.contract != *escrow
        || (context.fn_name != Symbol::new(env, "release")
            && context.fn_name != Symbol::new(env, "refund"))
        || context.args.len() != 2
    {
        return false;
    }
    let caller_val = context.args.get(1).unwrap();
    Address::try_from_val(env, &caller_val)
        .map(|caller| caller == env.current_contract_address())
        .unwrap_or(false)
}

fn verify_signatures(
    env: &Env,
    payload: &BytesN<32>,
    signatures: &Vec<SignerSignature>,
    threshold: u32,
    signer_count: u32,
) -> Result<(), Error> {
    if signatures.is_empty() || signatures.len() > signer_count || signatures.len() > MAX_SIGNERS {
        return Err(Error::InvalidSignature);
    }
    let message: Bytes = payload.clone().into();
    let mut valid = 0u32;
    for i in 0..signatures.len() {
        let item = signatures.get(i).unwrap();
        if !is_signer(env, &item.public_key) {
            return Err(Error::InvalidSignature);
        }
        for prior_index in 0..i {
            if signatures.get(prior_index).unwrap().public_key == item.public_key {
                return Err(Error::InvalidSignature);
            }
        }
        // The host traps on an invalid Ed25519 signature, failing the whole
        // authorization. Only registered distinct keys count toward M.
        env.crypto()
            .ed25519_verify(&item.public_key, &message, &item.signature);
        valid += 1;
    }
    if valid < threshold {
        return Err(Error::InvalidSignature);
    }
    Ok(())
}

fn management_digest(env: &Env, action: &ManagementAction, nonce: u64) -> Hash<32> {
    let payload = (
        symbol_short!("DOCESCROW"),
        env.current_contract_address(),
        nonce,
        action.clone(),
    )
        .to_xdr(env);
    env.crypto().sha256(&payload)
}

fn is_signer(env: &Env, public_key: &BytesN<32>) -> bool {
    env.storage()
        .persistent()
        .has(&DataKey::Signer(public_key.clone()))
}

fn get<T: TryFromVal<Env, Val>>(env: &Env, key: &DataKey) -> T {
    env.storage().persistent().get(key).unwrap()
}

#[cfg(test)]
mod tests;
