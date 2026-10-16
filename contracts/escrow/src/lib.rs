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
    contract, contracterror, contractimpl, contracttype, token, Address, Env, String, TryFromVal,
    TryIntoVal, Val,
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
    /// The only address permitted to call `release`/`refund` on this
    /// escrow. Set once at `create_escrow` time — see docs/adr/0002.
    pub releaser: Address,
    /// Optional deadline (unix seconds) after which `refund` opens to
    /// anyone — still only back to `payer`. `None` means no timeout,
    /// behaviour identical to before this field existed — see docs/adr/0004.
    pub refund_after: Option<u64>,
}

/// Exact `EscrowData` layout deployed before ADR 0004 added `refund_after`.
/// Soroban stores named contract structs as `ScVal::Map`; the field set here
/// intentionally matches the historical seven-field map exactly.
#[contracttype]
#[derive(Clone)]
struct EscrowDataV1 {
    payer: Address,
    payee: Address,
    token: Address,
    amount: i128,
    condition_ref: String,
    status: EscrowStatus,
    releaser: Address,
}

/// Exact current eight-field record layout, wrapped by `StoredEscrowData`
/// for every write made by this version of the contract.
#[contracttype]
#[derive(Clone)]
struct EscrowDataV2 {
    payer: Address,
    payee: Address,
    token: Address,
    amount: i128,
    condition_ref: String,
    status: EscrowStatus,
    releaser: Address,
    refund_after: Option<u64>,
}

/// Version tag for newly written persistent escrow records. Do not add fields
/// to a versioned struct; add a new versioned struct and enum variant instead.
#[contracttype]
#[derive(Clone)]
enum StoredEscrowData {
    V1(EscrowDataV1),
    V2(EscrowDataV2),
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
    /// A persistent escrow value does not match a supported historical or
    /// versioned layout; fail closed instead of guessing at its contents.
    UnsupportedStorageVersion = 20,
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
        Self::save_escrow(&env, id, &data);
        Ok(id)
    }

    /// Read-only status query. Errors if `escrow_id` doesn't exist.
    pub fn get_status(env: Env, escrow_id: u64) -> Result<EscrowStatus, Error> {
        let data = Self::load_escrow(&env, escrow_id)?;
        Ok(data.status)
    }

    /// Read-only accessor for everything stored about `escrow_id` —
    /// payer, payee, token, amount, `condition_ref`, status, `releaser`
    /// and `refund_after`. Exists so payees and integrators can check
    /// the deadline before relying on a `Funded` escrow (docs/adr/0004,
    /// threat model T8). Errors on an unknown id.
    pub fn get_escrow(env: Env, escrow_id: u64) -> Result<EscrowData, Error> {
        Self::load_escrow(&env, escrow_id)
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

        let mut data = Self::load_escrow(&env, escrow_id)?;

        if caller != data.releaser {
            return Err(Error::Unauthorized);
        }
        if data.status != EscrowStatus::Funded {
            return Err(Error::NotFunded);
        }

        let token_client = token::Client::new(&env, &data.token);
        token_client.transfer(&env.current_contract_address(), &data.payee, &data.amount);

        data.status = EscrowStatus::Released;
        Self::save_escrow(&env, escrow_id, &data);
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

        let mut data = Self::load_escrow(&env, escrow_id)?;

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
        Self::save_escrow(&env, escrow_id, &data);
        Ok(())
    }

    fn next_id(env: &Env) -> u64 {
        let id: u64 = env.storage().instance().get(&DataKey::NextId).unwrap_or(0);
        env.storage().instance().set(&DataKey::NextId, &(id + 1));
        id
    }

    fn load_escrow(env: &Env, escrow_id: u64) -> Result<EscrowData, Error> {
        let raw: Val = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .ok_or(Error::NotFound)?;

        // Before version tags existed, Soroban stored named contract structs
        // directly as maps. Decode only the two exact historical schemas.
        if let Ok(v1) = EscrowDataV1::try_from_val(env, &raw) {
            return Ok(Self::from_v1(v1));
        }
        if let Ok(v2) = EscrowDataV2::try_from_val(env, &raw) {
            return Ok(Self::from_v2(v2));
        }

        // New records are tagged enums (ScVal::Vec). Unknown variants and
        // malformed values fail closed; no fields are inferred or defaulted.
        let stored: StoredEscrowData = raw
            .try_into_val(env)
            .map_err(|_| Error::UnsupportedStorageVersion)?;
        match stored {
            StoredEscrowData::V1(v1) => Ok(Self::from_v1(v1)),
            StoredEscrowData::V2(v2) => Ok(Self::from_v2(v2)),
        }
    }

    fn save_escrow(env: &Env, escrow_id: u64, data: &EscrowData) {
        let v2 = EscrowDataV2 {
            payer: data.payer.clone(),
            payee: data.payee.clone(),
            token: data.token.clone(),
            amount: data.amount,
            condition_ref: data.condition_ref.clone(),
            status: data.status.clone(),
            releaser: data.releaser.clone(),
            refund_after: data.refund_after,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), &StoredEscrowData::V2(v2));
    }

    fn from_v1(v1: EscrowDataV1) -> EscrowData {
        EscrowData {
            payer: v1.payer,
            payee: v1.payee,
            token: v1.token,
            amount: v1.amount,
            condition_ref: v1.condition_ref,
            status: v1.status,
            releaser: v1.releaser,
            refund_after: None,
        }
    }

    fn from_v2(v2: EscrowDataV2) -> EscrowData {
        EscrowData {
            payer: v2.payer,
            payee: v2.payee,
            token: v2.token,
            amount: v2.amount,
            condition_ref: v2.condition_ref,
            status: v2.status,
            releaser: v2.releaser,
            refund_after: v2.refund_after,
        }
    }
}
