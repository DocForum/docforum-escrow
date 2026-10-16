// Soroban escrow contract.
//
// Phase E1 (see ROADMAP.md): create_escrow, get_status.
// Phase E2: release, refund. Both restricted to the escrow's `releaser`
// address, set at create_escrow time — see docs/adr/0002 for why a
// per-escrow releaser was chosen over a single contract-level admin.
// Phase E4 (issue #11): optional `refund_after` timeout refund — see
// docs/adr/0004. After that deadline anyone may refund, but only back to
// the payer, so a lost `releaser` key can no longer lock funds forever.
//
// Hard rule (see ARCHITECTURE_ESSENTIALS.md / docs/adr/0001): the contract
// enforces WHO may act, not WHY. `condition_ref` is opaque — the contract
// never interprets it. Keep it that way; domain logic belongs in the
// consuming application (docforum-core), never here.
#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, token, Address, Env, String, Vec,
};

/// A direct recipient and their share of an escrow, expressed in basis points.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PayeeShare {
    pub payee: Address,
    pub basis_points: u32,
}

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
    /// Optional deadline (unix seconds) after which `refund` opens to
    /// anyone — still only back to `payer`. `None` means no timeout,
    /// behaviour identical to before this field existed — see docs/adr/0004.
    pub refund_after: Option<u64>,
    /// Recipients paid directly by `release`. `payee` remains the first
    /// recipient for compatibility with existing single-payee callers.
    pub payees: Vec<PayeeShare>,
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
    /// `refund_after` was not strictly in the future at creation — see
    /// docs/adr/0004: a deadline that has already passed would let
    /// anyone refund the escrow before the releaser could ever act.
    InvalidRefundAfter = 5,
    /// The contract's token balance didn't rise by exactly `amount`
    /// across `create_escrow`'s transfer (a lying or short-delivering
    /// token) — see docs/threat-model.md T5.
    BalanceMismatch = 6,
    InvalidPayeeList = 30,
    TooManyPayees = 31,
    DuplicatePayee = 32,
    InvalidBasisPoints = 33,
    SplitAmountOverflow = 34,
}

#[contract]
pub struct EscrowContract;

#[contractimpl]
impl EscrowContract {
    /// Locks `amount` of `token` pulled from `payer`, held for `payee`,
    /// tagged with an opaque `condition_ref`. `releaser` is the only
    /// address that will later be permitted to call `release`/`refund`
    /// on this escrow (see docs/adr/0002). `refund_after` is an optional
    /// unix timestamp after which `refund` opens to any caller, always
    /// back to `payer` (docs/adr/0004); `None` means no timeout.
    /// Requires `payer` auth (the contract moves their funds). Returns
    /// the new escrow's id.
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
        let mut payees = Vec::new(&env);
        payees.push_back(PayeeShare {
            payee: payee.clone(),
            basis_points: 10_000,
        });
        Self::create_escrow_inner(
            env,
            payer,
            payees,
            token,
            amount,
            condition_ref,
            releaser,
            refund_after,
        )
    }

    /// Locks funds for a bounded list of direct recipients. Shares must be
    /// unique and sum to exactly 10,000 basis points. `release` distributes
    /// floor-rounded shares in list order and gives all rounding dust to the
    /// final recipient. The existing `create_escrow` method is the one-entry
    /// 10,000-basis-point form of this operation.
    pub fn create_split_escrow(
        env: Env,
        payer: Address,
        payees: Vec<PayeeShare>,
        token: Address,
        amount: i128,
        condition_ref: String,
        releaser: Address,
        refund_after: Option<u64>,
    ) -> Result<u64, Error> {
        Self::create_escrow_inner(
            env,
            payer,
            payees,
            token,
            amount,
            condition_ref,
            releaser,
            refund_after,
        )
    }

    fn create_escrow_inner(
        env: Env,
        payer: Address,
        payees: Vec<PayeeShare>,
        token: Address,
        amount: i128,
        condition_ref: String,
        releaser: Address,
        refund_after: Option<u64>,
    ) -> Result<u64, Error> {
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if payees.is_empty() {
            return Err(Error::InvalidPayeeList);
        }
        if payees.len() > 8 {
            return Err(Error::TooManyPayees);
        }
        let mut total_bps = 0u32;
        for i in 0..payees.len() {
            let share = payees.get(i).ok_or(Error::InvalidPayeeList)?;
            if share.basis_points == 0 {
                return Err(Error::InvalidBasisPoints);
            }
            total_bps = total_bps
                .checked_add(share.basis_points)
                .ok_or(Error::InvalidBasisPoints)?;
            for j in 0..i {
                if payees.get(j).ok_or(Error::InvalidPayeeList)?.payee == share.payee {
                    return Err(Error::DuplicatePayee);
                }
            }
        }
        if total_bps != 10_000 {
            return Err(Error::InvalidBasisPoints);
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
        let primary_payee = payees.get(0).ok_or(Error::InvalidPayeeList)?.payee;
        let data = EscrowData {
            payer,
            payee: primary_payee,
            token,
            amount,
            condition_ref,
            status: EscrowStatus::Funded,
            releaser,
            refund_after,
            payees,
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

    /// Read-only accessor for everything stored about `escrow_id` —
    /// payer, payee, token, amount, `condition_ref`, status, `releaser`
    /// and `refund_after`. Exists so payees and integrators can check
    /// the deadline before relying on a `Funded` escrow (docs/adr/0004,
    /// threat model T8). Errors on an unknown id.
    pub fn get_escrow(env: Env, escrow_id: u64) -> Result<EscrowData, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .ok_or(Error::NotFound)
    }

    /// Moves the escrowed `amount` to `payee`. Only the escrow's
    /// `releaser` (set at `create_escrow` time) may call this — the
    /// contract enforces WHO, never WHY (ADR 0001). Errors if the
    /// escrow doesn't exist, `caller` isn't the releaser, or the escrow
    /// isn't currently `Funded` (no double-release, no releasing a
    /// refunded escrow).
    ///
    /// Deliberately **not** gated by `refund_after` (docs/adr/0004): after
    /// the deadline the releaser can still release, racing any timeout
    /// refund — whoever lands first wins and the other fails `NotFunded`.
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
        let mut distributed = 0i128;
        for i in 0..data.payees.len() {
            let share = data.payees.get(i).ok_or(Error::InvalidPayeeList)?;
            let amount = if i + 1 == data.payees.len() {
                data.amount
                    .checked_sub(distributed)
                    .ok_or(Error::SplitAmountOverflow)?
            } else {
                let quotient = data.amount / 10_000;
                let remainder = data.amount % 10_000;
                quotient
                    .checked_mul(share.basis_points as i128)
                    .and_then(|whole| {
                        remainder
                            .checked_mul(share.basis_points as i128)
                            .map(|fraction| whole + fraction / 10_000)
                    })
                    .ok_or(Error::SplitAmountOverflow)?
            };
            distributed = distributed
                .checked_add(amount)
                .ok_or(Error::SplitAmountOverflow)?;
            if amount > 0 {
                token_client.transfer(&env.current_contract_address(), &share.payee, &amount);
            }
        }

        data.status = EscrowStatus::Released;
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), &data);
        Ok(())
    }

    /// Returns the escrowed `amount` to `payer`. Same state rule as
    /// `release` (only while `Funded`), but two callers are authorised:
    ///
    /// - the escrow's `releaser` (docs/adr/0002), always; or
    /// - **anyone**, once `refund_after` has been reached — the timeout
    ///   refund path for a lost/unsignable `releaser` key (docs/adr/0004).
    ///
    /// The destination never changes: timeout or not, funds only ever go
    /// back to the stored `payer`. With no `refund_after` set, behaviour
    /// is identical to before the timeout existed — releaser only.
    pub fn refund(env: Env, escrow_id: u64, caller: Address) -> Result<(), Error> {
        caller.require_auth();

        let mut data: EscrowData = env
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

        data.status = EscrowStatus::Refunded;
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), &data);
        Ok(())
    }

    fn next_id(env: &Env) -> u64 {
        let id: u64 = env.storage().instance().get(&DataKey::NextId).unwrap_or(0);
        env.storage().instance().set(&DataKey::NextId, &(id + 1));
        id
    }
}
