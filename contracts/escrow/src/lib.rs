// Soroban escrow contract.
//
// Phase E1 (see ROADMAP.md): create_escrow, get_status.
// Phase E2: release, refund. Both restricted to the escrow's `releaser`
// address, set at create_escrow time — see docs/adr/0002 for why a
// per-escrow releaser was chosen over a single contract-level admin.
//
// Hard rule (see ARCHITECTURE_ESSENTIALS.md / docs/adr/0001): the contract
// enforces WHO may act, not WHY. `condition_ref` is opaque — the contract
// never interprets it. Keep it that way; domain logic belongs in the
// consuming application (docforum-core), never here.
#![no_std]

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, token, Address, Env, String};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EscrowStatus {
    Funded,
    Released,
    Refunded,
}

#[contracttype]
#[derive(Clone)]
pub struct EscrowData {
    pub payer: Address,
    pub payee: Address,
    pub token: Address,
    pub amount: i128,
    pub condition_ref: String,
    pub status: EscrowStatus,
    /// The only address permitted to call `release`/`refund` on this
    /// escrow. Set once at `create_escrow` time — see docs/adr/0002.
    pub releaser: Address,
}

#[contracttype]
enum DataKey {
    Escrow(u64),
    NextId,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotFound = 1,
    InvalidAmount = 2,
    Unauthorized = 3,
    NotFunded = 4,
}

#[contract]
pub struct EscrowContract;

#[contractimpl]
impl EscrowContract {
    /// Locks `amount` of `token` pulled from `payer`, held for `payee`,
    /// tagged with an opaque `condition_ref`. `releaser` is the only
    /// address that will later be permitted to call `release`/`refund`
    /// on this escrow (see docs/adr/0002). Requires `payer` auth (the
    /// contract moves their funds). Returns the new escrow's id.
    pub fn create_escrow(
        env: Env,
        payer: Address,
        payee: Address,
        token: Address,
        amount: i128,
        condition_ref: String,
        releaser: Address,
    ) -> Result<u64, Error> {
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        payer.require_auth();

        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&payer, &env.current_contract_address(), &amount);

        let id = Self::next_id(&env);
        let data = EscrowData {
            payer,
            payee,
            token,
            amount,
            condition_ref,
            status: EscrowStatus::Funded,
            releaser,
        };
        env.storage().persistent().set(&DataKey::Escrow(id), &data);
        Ok(id)
    }

    /// Read-only status query. Errors if `escrow_id` doesn't exist.
    pub fn get_status(env: Env, escrow_id: u64) -> Result<EscrowStatus, Error> {
        let data: EscrowData = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .ok_or(Error::NotFound)?;
        Ok(data.status)
    }

    /// Moves the escrowed `amount` to `payee`. Only the escrow's
    /// `releaser` (set at `create_escrow` time) may call this — the
    /// contract enforces WHO, never WHY (ADR 0001). Errors if the
    /// escrow doesn't exist, `caller` isn't the releaser, or the escrow
    /// isn't currently `Funded` (no double-release, no releasing a
    /// refunded escrow).
    pub fn release(env: Env, escrow_id: u64, caller: Address) -> Result<(), Error> {
        caller.require_auth();

        let mut data: EscrowData = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .ok_or(Error::NotFound)?;

        if caller != data.releaser {
            return Err(Error::Unauthorized);
        }
        if data.status != EscrowStatus::Funded {
            return Err(Error::NotFunded);
        }

        let token_client = token::Client::new(&env, &data.token);
        token_client.transfer(&env.current_contract_address(), &data.payee, &data.amount);

        data.status = EscrowStatus::Released;
        env.storage().persistent().set(&DataKey::Escrow(escrow_id), &data);
        Ok(())
    }

    /// Returns the escrowed `amount` to `payer`. Same authorization and
    /// state rules as `release` (see above) — only the escrow's
    /// `releaser` may call this, only while `Funded`.
    pub fn refund(env: Env, escrow_id: u64, caller: Address) -> Result<(), Error> {
        caller.require_auth();

        let mut data: EscrowData = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .ok_or(Error::NotFound)?;

        if caller != data.releaser {
            return Err(Error::Unauthorized);
        }
        if data.status != EscrowStatus::Funded {
            return Err(Error::NotFunded);
        }

        let token_client = token::Client::new(&env, &data.token);
        token_client.transfer(&env.current_contract_address(), &data.payer, &data.amount);

        data.status = EscrowStatus::Refunded;
        env.storage().persistent().set(&DataKey::Escrow(escrow_id), &data);
        Ok(())
    }

    fn next_id(env: &Env) -> u64 {
        let id: u64 = env.storage().instance().get(&DataKey::NextId).unwrap_or(0);
        env.storage().instance().set(&DataKey::NextId, &(id + 1));
        id
    }
}
