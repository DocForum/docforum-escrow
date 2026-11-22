#![no_std]

use soroban_sdk::{
    auth::{Context, CustomAccountInterface},
    contract, contracterror, contractimpl, contracttype,
    crypto::Hash,
    symbol_short,
    xdr::ToXdr,
    Address, Bytes, BytesN, Env, Symbol, TryFromVal, Val, Vec,
};

const MAX_SIGNERS: u32 = 20;

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SettleAction {
    Release,
    Refund,
}

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
    /// Policy changes require signatures from every registered signer.
    SetPolicy(u32, u32),
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Escrow,
    Threshold,
    Signer(BytesN<32>),
    SignerCount,
    ManagementNonce,
    MaxOperationsPerWindow,
    WindowLedgers,
    WindowUsage(u32),
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
    InvalidPolicy = 9,
    RateLimited = 10,
}

#[contract]
pub struct ReleaserAccount;

#[contractimpl]
impl ReleaserAccount {
    /// Initializes an escrow target, M-of-N signer set, and operation cap.
    pub fn __constructor(
        env: Env,
        escrow: Address,
        signers: Vec<BytesN<32>>,
        threshold: u32,
        max_operations_per_window: u32,
        window_ledgers: u32,
    ) {
        if signers.is_empty()
            || signers.len() > MAX_SIGNERS
            || threshold == 0
            || threshold > signers.len()
        {
            env.panic_with_error(Error::InvalidConfiguration);
        }
        if max_operations_per_window == 0
            || window_ledgers == 0
            || window_ledgers >= env.storage().max_ttl()
        {
            env.panic_with_error(Error::InvalidPolicy);
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
        env.storage()
            .persistent()
            .set(&DataKey::MaxOperationsPerWindow, &max_operations_per_window);
        env.storage()
            .persistent()
            .set(&DataKey::WindowLedgers, &window_ledgers);
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

    pub fn policy(env: Env) -> (u32, u32) {
        (
            get(&env, &DataKey::MaxOperationsPerWindow),
            get(&env, &DataKey::WindowLedgers),
        )
    }

    pub fn window_usage(env: Env, window: u32) -> u32 {
        // Temporary storage: an expired counter is simply absent, so this
        // returns 0 instead of trapping. Callers can therefore read a past
        // window safely after it has rolled off.
        env.storage()
            .temporary()
            .get(&DataKey::WindowUsage(window))
            .unwrap_or(0)
    }

    /// Returns the exact digest the current threshold must sign for the next
    /// management operation. The advancing nonce prevents replay.
    pub fn management_payload(env: Env, action: ManagementAction) -> BytesN<32> {
        management_digest(&env, &action, get(&env, &DataKey::ManagementNonce)).to_bytes()
    }

    /// Changes signers/threshold at the current quorum. Cap changes require
    /// signatures from every registered signer.
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
            ManagementAction::SetPolicy(max_operations_per_window, window_ledgers) => {
                if signatures.len() != get::<u32>(&env, &DataKey::SignerCount) {
                    return Err(Error::InvalidSignature);
                }
                if max_operations_per_window == 0
                    || window_ledgers == 0
                    || window_ledgers >= env.storage().max_ttl()
                {
                    return Err(Error::InvalidPolicy);
                }
                env.storage()
                    .persistent()
                    .set(&DataKey::MaxOperationsPerWindow, &max_operations_per_window);
                env.storage()
                    .persistent()
                    .set(&DataKey::WindowLedgers, &window_ledgers);
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
        let op_count = authorize_context(&env, &escrow, &auth_contexts)?;
        let payload = signature_payload.to_bytes();
        verify_signatures(
            &env,
            &payload,
            &signatures,
            get(&env, &DataKey::Threshold),
            get(&env, &DataKey::SignerCount),
        )?;
        consume_operation_slots(&env, op_count)
    }
}

fn authorize_context(env: &Env, escrow: &Address, contexts: &Vec<Context>) -> Result<u32, Error> {
    // One account auth entry authorizes one escrow operation or batch. Additional or
    // nested auth contexts are rejected rather than implicitly covered.
    if contexts.len() != 1 {
        return Err(Error::UnauthorizedContext);
    }
    let Some(Context::Contract(context)) = contexts.first() else {
        return Err(Error::UnauthorizedContext);
    };
    if context.contract != *escrow {
        return Err(Error::UnauthorizedContext);
    }

    let is_release = context.fn_name == Symbol::new(env, "release");
    let is_refund = context.fn_name == Symbol::new(env, "refund");
    let is_rotate = context.fn_name == Symbol::new(env, "rotate_releaser");
    let is_settle_many = context.fn_name == Symbol::new(env, "settle_many");

    if (is_release || is_refund) && context.args.len() == 2 {
        let caller_val = context.args.get(1).unwrap();
        let is_self = Address::try_from_val(env, &caller_val)
            .map(|caller| caller == env.current_contract_address())
            .unwrap_or(false);
        if !is_self {
            return Err(Error::UnauthorizedContext);
        }
        return Ok(1);
    }

    if is_rotate && context.args.len() == 3 {
        let caller_val = context.args.get(1).unwrap();
        let is_self = Address::try_from_val(env, &caller_val)
            .map(|caller| caller == env.current_contract_address())
            .unwrap_or(false);
        if !is_self {
            return Err(Error::UnauthorizedContext);
        }
        return Ok(1);
    }

    if is_settle_many && context.args.len() == 2 {
        let caller_val = context.args.get(0).unwrap();
        let is_self = Address::try_from_val(env, &caller_val)
            .map(|caller| caller == env.current_contract_address())
            .unwrap_or(false);
        if !is_self {
            return Err(Error::UnauthorizedContext);
        }
        let ops_val = context.args.get(1).unwrap();
        let Ok(ops) = Vec::<(u64, SettleAction)>::try_from_val(env, &ops_val) else {
            return Err(Error::UnauthorizedContext);
        };
        if ops.is_empty() {
            return Err(Error::UnauthorizedContext);
        }
        return Ok(ops.len());
    }

    Err(Error::UnauthorizedContext)
}

fn escrow_operation_only(env: &Env, escrow: &Address, contexts: &Vec<Context>) -> bool {
    authorize_context(env, escrow, contexts).is_ok()
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

fn consume_operation_slots(env: &Env, count: u32) -> Result<(), Error> {
    let cap: u32 = get(env, &DataKey::MaxOperationsPerWindow);
    let window_ledgers: u32 = get(env, &DataKey::WindowLedgers);
    let window = env.ledger().sequence().saturating_sub(1) / window_ledgers;
    let key = DataKey::WindowUsage(window);
    // Window counters live in temporary storage: they are only relevant for
    // the duration of their window and can be recreated (with a fresh count)
    // afterwards, so they no longer pay persistent rent forever.
    let used: u32 = env.storage().temporary().get(&key).unwrap_or(0);
    let new_used = used.checked_add(count).ok_or(Error::RateLimited)?;
    if new_used > cap {
        return Err(Error::RateLimited);
    }
    env.storage().temporary().set(&key, &new_used);
    // TTL arithmetic: window index `w` covers ledgers
    //   [w * window_ledgers + 1, (w + 1) * window_ledgers].
    // In the worst case the counter is created on the first ledger of its
    // window, so it must live at least `window_ledgers` ledgers to reach the
    // window's last ledger; add a 1-ledger margin so it can never expire
    // before the window ends (which would let the cap be bypassed). Clamp to
    // the network maximum so we never request more than `max_ttl`.
    let ttl = (window_ledgers + 1).min(env.storage().max_ttl());
    env.storage()
        .temporary()
        .extend_ttl(&key, ttl.saturating_sub(1), ttl);
    Ok(())
}

fn consume_operation_slot(env: &Env) -> Result<(), Error> {
    consume_operation_slots(env, 1)
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
