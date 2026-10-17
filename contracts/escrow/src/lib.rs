// Soroban escrow contract.
//
// Phase E1: create_escrow, get_status.
// Phase E2: release, refund (per-escrow releaser, docs/adr/0002).
// Phase E4: optional refund_after timeout (docs/adr/0004), balance-delta
//           check (threat model T5).
// Phase E5 (issue #48): events + tombstone on settlement (docs/adr/0005).
//
// Hard rule (ARCHITECTURE_ESSENTIALS.md / docs/adr/0001): the contract
// enforces WHO may act, not WHY. condition_ref is opaque.
#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, Env, String,
};

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
    pub releaser: Address,
    pub refund_after: Option<u64>,
}

/// LF / issue #48 tombstone: the only state kept for a settled escrow.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SettledEscrow {
    pub status: EscrowStatus,
}

#[contracttype]
enum DataKey {
    Escrow(u64),
    SettledEscrow(u64),
    NextId,
}

#[contracttype]
#[derive(Clone)]
pub struct EscrowCreatedEvent {
    pub escrow_id: u64,
    pub payer: Address,
    pub payee: Address,
    pub token: Address,
    pub amount: i128,
    pub condition_ref: String,
    pub releaser: Address,
    pub refund_after: Option<u64>,
}

#[contracttype]
#[derive(Clone)]
pub struct EscrowReleasedEvent {
    pub escrow_id: u64,
    pub payer: Address,
    pub payee: Address,
    pub token: Address,
    pub amount: i128,
    pub condition_ref: String,
    pub releaser: Address,
}

#[contracttype]
#[derive(Clone)]
pub struct EscrowRefundedEvent {
    pub escrow_id: u64,
    pub payer: Address,
    pub payee: Address,
    pub token: Address,
    pub amount: i128,
    pub condition_ref: String,
    pub caller: Address,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotFound = 1,
    InvalidAmount = 2,
    Unauthorized = 3,
    NotFunded = 4,
    InvalidRefundAfter = 5,
    BalanceMismatch = 6,
}

#[contract]
pub struct EscrowContract;

#[contractimpl]
impl EscrowContract {
    pub fn create_escrow(
        env: Env,
        payer: Address,
        payee: Address,
        token: Address,
        amount: i128,
        condition_ref: String,
        releaser: Address,
        refund_after: Option<u64>,
    ) -> Result<u64, Error> {
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if let Some(deadline) = refund_after {
            if deadline <= env.ledger().timestamp() {
                return Err(Error::InvalidRefundAfter);
            }
        }
        payer.require_auth();

        let token_client = token::Client::new(&env, &token);
        let contract_address = env.current_contract_address();
        let balance_before = token_client.balance(&contract_address);
        token_client.transfer(&payer, &contract_address, &amount);
        let balance_after = token_client.balance(&contract_address);
        if balance_after.checked_sub(balance_before) != Some(amount) {
            return Err(Error::BalanceMismatch);
        }

        let id = Self::next_id(&env);
        let data = EscrowData {
            payer: payer.clone(),
            payee: payee.clone(),
            token: token.clone(),
            amount,
            condition_ref: condition_ref.clone(),
            status: EscrowStatus::Funded,
            releaser: releaser.clone(),
            refund_after,
        };
        env.storage().persistent().set(&DataKey::Escrow(id), &data);

        env.events().publish(
            (symbol_short!("created"), id),
            EscrowCreatedEvent {
                escrow_id: id,
                payer,
                payee,
                token,
                amount,
                condition_ref,
                releaser,
                refund_after,
            },
        );

        Ok(id)
    }

    /// Status query for an escrow id. For settled ids, answers from the
    /// tombstone; for funded ids, from the full record. NotFound means the
    /// id was never created.
    pub fn get_status(env: Env, escrow_id: u64) -> Result<EscrowStatus, Error> {
        if let Some(data) = env
            .storage()
            .persistent()
            .get::<_, EscrowData>(&DataKey::Escrow(escrow_id))
        {
            return Ok(data.status);
        }
        if let Some(tombstone) = env
            .storage()
            .persistent()
            .get::<_, SettledEscrow>(&DataKey::SettledEscrow(escrow_id))
        {
            return Ok(tombstone.status);
        }
        Err(Error::NotFound)
    }

    /// Full-record read for pre-settlement escrows. Returns NotFound after
    /// settlement (see docs/adr/0005) - use get_status for settled ids.
    pub fn get_escrow(env: Env, escrow_id: u64) -> Result<EscrowData, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .ok_or(Error::NotFound)
    }

    pub fn release(env: Env, escrow_id: u64, caller: Address) -> Result<(), Error> {
        caller.require_auth();

        let data: EscrowData = env
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

        // Issue #48: publish full history, then replace the full record with
        // a tombstone to reclaim storage. Event log is the audit source.
        env.events().publish(
            (symbol_short!("released"), escrow_id),
            EscrowReleasedEvent {
                escrow_id,
                payer: data.payer.clone(),
                payee: data.payee.clone(),
                token: data.token.clone(),
                amount: data.amount,
                condition_ref: data.condition_ref.clone(),
                releaser: data.releaser.clone(),
            },
        );

        env.storage().persistent().remove(&DataKey::Escrow(escrow_id));
        env.storage().persistent().set(
            &DataKey::SettledEscrow(escrow_id),
            &SettledEscrow {
                status: EscrowStatus::Released,
            },
        );

        Ok(())
    }

    pub fn refund(env: Env, escrow_id: u64, caller: Address) -> Result<(), Error> {
        caller.require_auth();

        let data: EscrowData = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .ok_or(Error::NotFound)?;

        let timeout_passed = match data.refund_after {
            Some(deadline) => env.ledger().timestamp() >= deadline,
            None => false,
        };
        if caller != data.releaser && !timeout_passed {
            return Err(Error::Unauthorized);
        }
        if data.status != EscrowStatus::Funded {
            return Err(Error::NotFunded);
        }

        let token_client = token::Client::new(&env, &data.token);
        token_client.transfer(&env.current_contract_address(), &data.payer, &data.amount);

        env.events().publish(
            (symbol_short!("refunded"), escrow_id),
            EscrowRefundedEvent {
                escrow_id,
                payer: data.payer.clone(),
                payee: data.payee.clone(),
                token: data.token.clone(),
                amount: data.amount,
                condition_ref: data.condition_ref.clone(),
                caller: caller.clone(),
            },
        );

        env.storage().persistent().remove(&DataKey::Escrow(escrow_id));
        env.storage().persistent().set(
            &DataKey::SettledEscrow(escrow_id),
            &SettledEscrow {
                status: EscrowStatus::Refunded,
            },
        );

        Ok(())
    }

    fn next_id(env: &Env) -> u64 {
        let id: u64 = env.storage().instance().get(&DataKey::NextId).unwrap_or(0);
        env.storage().instance().set(&DataKey::NextId, &(id + 1));
        id
    }
}