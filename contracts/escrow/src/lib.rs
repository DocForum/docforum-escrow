// Soroban escrow contract.
//
// Phase E1 (see ROADMAP.md): create_escrow, get_status.
// Phase E2: release, refund. Both restricted to the escrow's `releaser`
// address, set at create_escrow time — see docs/adr/0002 for why a
// per-escrow releaser was chosen over a single contract-level admin.
// Phase E4 (issue #11): optional `refund_after` timeout refund — see
// docs/adr/0004. After that deadline anyone may refund, but only back to
// the payer, so a lost `releaser` key can no longer lock funds forever.
// Phase E5 (issue #21): fixed milestone schedules and partial refunds —
// see docs/adr/0005.
//
// Hard rule (see ARCHITECTURE_ESSENTIALS.md / docs/adr/0001): the contract
// enforces WHO may act, not WHY. `condition_ref` is opaque — the contract
// never interprets it. Keep it that way; domain logic belongs in the
// consuming application (docforum-core), never here.
#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, token, Address, Env, String, Vec,
};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EscrowStatus {
    Funded,
    PartiallyReleased,
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
    /// Immutable tranche schedule. `release` is retained for legacy
    /// one-tranche escrows; multi-tranche escrows use `release_milestone`.
    pub milestones: Vec<i128>,
    /// One flag per tranche, allowing releases in any order while making
    /// each tranche idempotent.
    pub released_milestones: Vec<bool>,
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
    /// Milestones must be positive and sum exactly to `amount`.
    InvalidMilestoneSchedule = 50,
    /// The selected milestone does not exist or has already been released.
    InvalidMilestone = 51,
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
            payer,
            payee,
            token,
            amount,
            condition_ref,
            status: EscrowStatus::Funded,
            releaser,
            refund_after,
            milestones: Vec::from_array(&env, [amount]),
            released_milestones: Vec::from_array(&env, [false]),
        };
        env.storage().persistent().set(&DataKey::Escrow(id), &data);
        Ok(id)
    }

    /// Creates an escrow with a fixed tranche schedule. Tranches may be
    /// released in any order; every amount must be positive and the sum
    /// must equal `amount`. Existing `create_escrow` remains the one-stage
    /// API and is stored as a single-tranche schedule.
    pub fn create_milestone_escrow(
        env: Env,
        payer: Address,
        payee: Address,
        token: Address,
        amount: i128,
        condition_ref: String,
        releaser: Address,
        refund_after: Option<u64>,
        milestones: Vec<i128>,
    ) -> Result<u64, Error> {
        if amount <= 0 || milestones.is_empty() {
            return Err(Error::InvalidMilestoneSchedule);
        }
        if let Some(deadline) = refund_after {
            if deadline <= env.ledger().timestamp() {
                return Err(Error::InvalidRefundAfter);
            }
        }
        let mut sum = 0_i128;
        let mut released_milestones = Vec::new(&env);
        for milestone in milestones.iter() {
            if milestone <= 0 {
                return Err(Error::InvalidMilestoneSchedule);
            }
            sum = sum
                .checked_add(milestone)
                .ok_or(Error::InvalidMilestoneSchedule)?;
            released_milestones.push_back(false);
        }
        if sum != amount {
            return Err(Error::InvalidMilestoneSchedule);
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
            payer,
            payee,
            token,
            amount,
            condition_ref,
            status: EscrowStatus::Funded,
            releaser,
            refund_after,
            milestones,
            released_milestones,
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
    /// payer, payee, token, amount, `condition_ref`, status, `releaser`,
    /// `refund_after`, and the milestone schedule/release flags. Exists so payees and integrators can check
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
        if data.status != EscrowStatus::Funded && data.status != EscrowStatus::PartiallyReleased {
            return Err(Error::NotFunded);
        }

        if data.milestones.len() != 1 {
            return Err(Error::InvalidMilestone);
        }

        let token_client = token::Client::new(&env, &data.token);
        Self::release_milestone_inner(&env, escrow_id, &mut data, 0, &token_client)?;
        Ok(())
    }

    /// Releases one fixed tranche to the escrow's payee. Out-of-order
    /// release is allowed; a tranche can be paid exactly once. The caller
    /// must be the stored releaser.
    pub fn release_milestone(
        env: Env,
        escrow_id: u64,
        index: u32,
        caller: Address,
    ) -> Result<(), Error> {
        caller.require_auth();
        let mut data: EscrowData = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .ok_or(Error::NotFound)?;
        if caller != data.releaser {
            return Err(Error::Unauthorized);
        }
        if data.status != EscrowStatus::Funded && data.status != EscrowStatus::PartiallyReleased {
            return Err(Error::NotFunded);
        }
        let token_client = token::Client::new(&env, &data.token);
        Self::release_milestone_inner(&env, escrow_id, &mut data, index, &token_client)
    }

    /// Returns the unreleased balance to `payer`. The escrow may be
    /// `Funded` or `PartiallyReleased`; prior tranche payouts are final.
    /// Two callers are authorised:
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
        if data.status != EscrowStatus::Funded && data.status != EscrowStatus::PartiallyReleased {
            return Err(Error::NotFunded);
        }

        let remaining = Self::remaining_amount(&data);
        let token_client = token::Client::new(&env, &data.token);
        if remaining > 0 {
            token_client.transfer(&env.current_contract_address(), &data.payer, &remaining);
        }

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

    fn release_milestone_inner(
        env: &Env,
        escrow_id: u64,
        data: &mut EscrowData,
        index: u32,
        token_client: &token::Client<'_>,
    ) -> Result<(), Error> {
        let amount = data.milestones.get(index).ok_or(Error::InvalidMilestone)?;
        if data
            .released_milestones
            .get(index)
            .ok_or(Error::InvalidMilestone)?
        {
            return Err(Error::InvalidMilestone);
        }
        token_client.transfer(&env.current_contract_address(), &data.payee, &amount);
        data.released_milestones.set(index, true);
        let mut all_released = true;
        for released in data.released_milestones.iter() {
            if !released {
                all_released = false;
            }
        }
        data.status = if all_released {
            EscrowStatus::Released
        } else {
            EscrowStatus::PartiallyReleased
        };
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), data);
        Ok(())
    }

    fn remaining_amount(data: &EscrowData) -> i128 {
        let mut released = 0_i128;
        for (index, amount) in data.milestones.iter().enumerate() {
            if data.released_milestones.get(index as u32).unwrap_or(false) {
                released += amount;
            }
        }
        data.amount - released
    }
}
