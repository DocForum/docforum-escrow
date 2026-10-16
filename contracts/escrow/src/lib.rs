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
    /// Optional deadline (unix seconds) after which `refund` opens to
    /// anyone — still only back to `payer`. `None` means no timeout,
    /// behaviour identical to before this field existed — see docs/adr/0004.
    pub refund_after: Option<u64>,
}

/// A stream vests linearly from `start` through `end`. When `cliff` is
/// present, accrued vesting becomes available at that timestamp.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VestingSchedule {
    pub start: u64,
    pub end: u64,
    pub cliff: Option<u64>,
}

/// Current on-chain vesting amounts for a streamed escrow.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VestingInfo {
    pub schedule: VestingSchedule,
    pub total_amount: i128,
    pub vested_amount: i128,
    pub withdrawn_amount: i128,
    pub claimable_amount: i128,
}

#[contracttype]
enum DataKey {
    Escrow(u64),
    NextId,
    Vesting(u64),
    Withdrawn(u64),
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
    /// The shared token balance cannot cover the remaining escrow amount.
    PoolInsufficient = 21,
    NotStreamed = 25,
    InvalidVestingSchedule = 26,
    NothingToWithdraw = 27,
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
        };
        env.storage().persistent().set(&DataKey::Escrow(id), &data);
        Ok(id)
    }

    /// Creates a time-locked linear stream. Before `cliff`, nothing is
    /// withdrawable; at the cliff the amount accrued since `start` becomes
    /// available. The full amount vests at `end`.
    pub fn create_streamed_escrow(
        env: Env,
        payer: Address,
        payee: Address,
        token: Address,
        amount: i128,
        condition_ref: String,
        releaser: Address,
        refund_after: Option<u64>,
        schedule: VestingSchedule,
    ) -> Result<u64, Error> {
        if schedule.start >= schedule.end
            || schedule
                .cliff
                .is_some_and(|cliff| cliff < schedule.start || cliff > schedule.end)
        {
            return Err(Error::InvalidVestingSchedule);
        }
        let escrow_id = Self::create_escrow(
            env.clone(),
            payer,
            payee,
            token,
            amount,
            condition_ref,
            releaser,
            refund_after,
        )?;
        env.storage()
            .persistent()
            .set(&DataKey::Vesting(escrow_id), &schedule);
        env.storage()
            .persistent()
            .set(&DataKey::Withdrawn(escrow_id), &0_i128);
        Ok(escrow_id)
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

    /// Returns the current linear-vesting amounts for a streamed escrow.
    pub fn get_vesting(env: Env, escrow_id: u64) -> Result<VestingInfo, Error> {
        let data: EscrowData = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .ok_or(Error::NotFound)?;
        let schedule: VestingSchedule = env
            .storage()
            .persistent()
            .get(&DataKey::Vesting(escrow_id))
            .ok_or(Error::NotStreamed)?;
        let withdrawn_amount: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::Withdrawn(escrow_id))
            .unwrap_or(0);
        let vested_amount = Self::vested_amount(data.amount, &schedule, env.ledger().timestamp());
        let claimable_amount = if data.status == EscrowStatus::Funded {
            vested_amount.saturating_sub(withdrawn_amount)
        } else {
            0
        };
        Ok(VestingInfo {
            schedule,
            total_amount: data.amount,
            vested_amount,
            withdrawn_amount,
            claimable_amount,
        })
    }

    /// Transfers the payee's vested-but-unwithdrawn stream amount.
    pub fn withdraw(env: Env, escrow_id: u64, payee: Address) -> Result<i128, Error> {
        payee.require_auth();
        let data: EscrowData = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .ok_or(Error::NotFound)?;
        if data.status != EscrowStatus::Funded {
            return Err(Error::NotFunded);
        }
        if payee != data.payee {
            return Err(Error::Unauthorized);
        }
        let schedule: VestingSchedule = env
            .storage()
            .persistent()
            .get(&DataKey::Vesting(escrow_id))
            .ok_or(Error::NotStreamed)?;
        let withdrawn: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::Withdrawn(escrow_id))
            .unwrap_or(0);
        let vested = Self::vested_amount(data.amount, &schedule, env.ledger().timestamp());
        let claimable = vested.saturating_sub(withdrawn);
        if claimable <= 0 {
            return Err(Error::NothingToWithdraw);
        }

        let token_client = token::Client::new(&env, &data.token);
        let contract_address = env.current_contract_address();
        if token_client.balance(&contract_address) < claimable {
            return Err(Error::PoolInsufficient);
        }
        token_client.transfer(&contract_address, &payee, &claimable);
        env.storage()
            .persistent()
            .set(&DataKey::Withdrawn(escrow_id), &(withdrawn + claimable));
        Ok(claimable)
    }

    /// Moves the escrow's remaining balance to `payee`. Only the escrow's
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

        let withdrawn: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::Withdrawn(escrow_id))
            .unwrap_or(0);
        let remaining = data.amount - withdrawn;
        let token_client = token::Client::new(&env, &data.token);
        let contract_address = env.current_contract_address();
        if token_client.balance(&contract_address) < remaining {
            return Err(Error::PoolInsufficient);
        }
        if remaining > 0 {
            token_client.transfer(&contract_address, &data.payee, &remaining);
        }
        if env
            .storage()
            .persistent()
            .has(&DataKey::Vesting(escrow_id))
        {
            env.storage()
                .persistent()
                .set(&DataKey::Withdrawn(escrow_id), &data.amount);
        }

        data.status = EscrowStatus::Released;
        env.storage().persistent().set(&DataKey::Escrow(escrow_id), &data);
        Ok(())
    }

    /// Returns a standard escrow's balance to `payer`. For a streamed
    /// escrow, pays vested-but-unwithdrawn funds to `payee` and returns
    /// only the unvested remainder to `payer`. Same state rule as
    /// `release` (only while `Funded`), but two callers are authorised:
    ///
    /// - the escrow's `releaser` (docs/adr/0002), always; or
    /// - **anyone**, once `refund_after` has been reached — the timeout
    ///   refund path for a lost/unsignable `releaser` key (docs/adr/0004).
    ///
    /// Destinations are always the stored `payer` and, for a stream, its
    /// stored `payee`; caller-provided destinations are never accepted.
    /// With no `refund_after` set, caller authorization remains releaser-only.
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

        let schedule: Option<VestingSchedule> = env
            .storage()
            .persistent()
            .get(&DataKey::Vesting(escrow_id));
        let withdrawn: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::Withdrawn(escrow_id))
            .unwrap_or(0);
        let streamed = schedule.is_some();
        let (payee_amount, payer_amount) = if let Some(schedule) = &schedule {
            let vested = Self::vested_amount(data.amount, schedule, env.ledger().timestamp());
            (vested.saturating_sub(withdrawn), data.amount - vested)
        } else {
            (0, data.amount)
        };

        let token_client = token::Client::new(&env, &data.token);
        let contract_address = env.current_contract_address();
        let balance = token_client.balance(&contract_address);
        let remaining = payee_amount + payer_amount;
        if balance < remaining {
            return Err(Error::PoolInsufficient);
        }
        if payee_amount > 0 {
            token_client.transfer(&contract_address, &data.payee, &payee_amount);
        }
        if payer_amount > 0 {
            token_client.transfer(&contract_address, &data.payer, &payer_amount);
        }
        if streamed {
            let vested = data.amount - payer_amount;
            env.storage()
                .persistent()
                .set(&DataKey::Withdrawn(escrow_id), &vested);
        }

        data.status = EscrowStatus::Refunded;
        env.storage().persistent().set(&DataKey::Escrow(escrow_id), &data);
        Ok(())
    }

    fn next_id(env: &Env) -> u64 {
        let id: u64 = env.storage().instance().get(&DataKey::NextId).unwrap_or(0);
        env.storage().instance().set(&DataKey::NextId, &(id + 1));
        id
    }

    /// Computes floor(total * elapsed / duration) without overflowing
    /// even when `total` approaches i128::MAX and timestamps span u64.
    fn vested_amount(total: i128, schedule: &VestingSchedule, now: u64) -> i128 {
        if now < schedule.start || schedule.cliff.is_some_and(|cliff| now < cliff) {
            return 0;
        }
        if now >= schedule.end {
            return total;
        }
        let duration = (schedule.end - schedule.start) as i128;
        let elapsed = (now - schedule.start) as i128;
        let whole = total / duration;
        let remainder = (total % duration) as u128;
        let fractional = remainder * (elapsed as u128) / (duration as u128);
        whole * elapsed + fractional as i128
    }
}
