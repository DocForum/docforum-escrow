// Soroban escrow contract.
//
// Phase E1: create_escrow, get_status.
// Phase E2: release, refund (per-escrow releaser, docs/adr/0002).
// Phase E4: optional refund_after timeout (docs/adr/0004), balance-delta
//           check (threat model T5).
// Phase E5 (issue #48): events + tombstone on settlement (docs/adr/0005).
// Phase E5 (issue #47): opt-in uniqueness of (payer, condition_ref) via
//           unique_ref = true. The key is kept after settlement so a retry
//           that lands after release/refund still gets the original id.
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

/// Issue #48 tombstone: the only state kept for a settled escrow.
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
    /// Issue #47: (payer, condition_ref) -> escrow id. Only written when
    /// create_escrow is called with unique_ref = true. Kept forever, even
    /// after settlement, so a retry that lands after release/refund still
    /// returns the original id (via get_escrow_id_by_ref) instead of
    /// double-funding.
    ConditionRef((Address, String)),
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
    pub unique_ref: bool,
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
    /// Issue #47: unique_ref = true was set and (payer, condition_ref)
    /// already maps to an existing escrow. Call get_escrow_id_by_ref to
    /// recover the original id - contracterror enums can't carry a payload.
    DuplicateConditionRef = 7,
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
        unique_ref: bool,
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

        // Issue #47: uniqueness check BEFORE the funding transfer, so a
        // duplicate retry costs nothing on-chain.
        let ref_key = DataKey::ConditionRef((payer.clone(), condition_ref.clone()));
        if unique_ref {
            if env.storage().persistent().has(&ref_key) {
                return Err(Error::DuplicateConditionRef);
            }
        }

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

        // Issue #47: write the uniqueness index AFTER the escrow record.
        // If any earlier step had returned Err, nothing is stored. Kept
        // forever - release/refund do NOT remove this entry, so a retry
        // after settlement still gets DuplicateConditionRef.
        if unique_ref {
            env.storage().persistent().set(&ref_key, &id);
        }

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
                unique_ref,
            },
        );

        Ok(id)
    }

    /// Read-only. For settled ids, answers from the tombstone; for funded
    /// ids, from the full record. NotFound means the id was never created.
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

    /// Issue #47: look up the escrow id previously created with
    /// unique_ref = true for this (payer, condition_ref). Returns the id
    /// even after settlement. NotFound means no unique-ref escrow exists
    /// for this pair.
    pub fn get_escrow_id_by_ref(
        env: Env,
        payer: Address,
        condition_ref: String,
    ) -> Result<u64, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::ConditionRef((payer, condition_ref)))
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