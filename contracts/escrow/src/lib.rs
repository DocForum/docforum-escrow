// Soroban escrow contract.
//
// Phase E1 (see ROADMAP.md): create_escrow, get_status.
// Phase E2: release, refund. Both restricted to the escrow's releaser
// address, set at create_escrow time — see docs/adr/0002 for why a
// per-escrow releaser was chosen over a single contract-level admin.
// Phase E4 (issue #11): optional `refund_after` timeout refund — see
// docs/adr/0004. After that deadline anyone may refund, but only back to
// the payer, so a lost `releaser` key can no longer lock funds forever.
// Phase E5 (issue #119): an escrow can instead be created with an M-of-N
// releaser set (`create_escrow_with_releasers`) — see docs/adr/0007.
// Single-releaser escrows are stored as a one-address set with threshold 1
// and behave exactly as before.
//
// Hard rule (see ARCHITECTURE_ESSENTIALS.md / docs/adr/0001): the contract
// enforces WHO may act, not WHY. `condition_ref` is opaque — the contract
// never interprets it. Keep it that way; domain logic belongs in the
// consuming application (docforum-core), never here.
#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, Env,
    IntoVal, Map, String, TryFromVal, TryIntoVal, Val, Vec,
};

/// Largest allowed releaser set for one escrow. Ten covers every
/// real-world multisig shape this primitive is meant to replace
/// (2-of-3, 3-of-5, ...) while keeping `create_escrow`'s validation,
/// `get_escrow`'s payload and the settlement path's auth checks cheap and
/// bounded. See docs/adr/0007.
pub const MAX_RELEASERS: u32 = 10;

/// Maximum `condition_ref` length in bytes (threat model T10, Phase E5).
pub const MAX_CONDITION_REF_LEN: u32 = 64;

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
    /// Addresses permitted to settle this escrow — see docs/adr/0002 for the
    /// per-escrow releaser, and docs/adr/0007 for M-of-N sets. A plain
    /// single-releaser escrow stores exactly one entry here.
    pub releasers: Vec<Address>,
    /// How many *distinct* addresses from `releasers` must authorize one
    /// settlement. Always `>= 1` and `<= releasers.len()`; `1` means any
    /// single releaser can settle (the pre-quorum behaviour).
    pub threshold: u32,
    /// Optional deadline (unix seconds) after which `refund` opens to
    /// anyone — still only back to `payer`. `None` means no timeout,
    /// behaviour identical to before this field existed — see docs/adr/0004.
    pub refund_after: Option<u64>,
    /// If true, invoke the contract payee's `on_escrow_released` hook after
    /// the payout transfer. A failed callback reverts the whole release.
    pub notify_payee: bool,
    /// Whether release requires the payee's explicit acceptance.
    pub requires_acceptance: bool,
    /// Ledger timestamp at which the payee accepted, if any.
    pub accepted_at: Option<u64>,
}

/// Exact seven-field map written before `refund_after` was introduced.
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

/// Exact eight-field map written after `refund_after` and before releaser sets.
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

/// Current versioned payload; future fields require a new variant.
#[contracttype]
#[derive(Clone)]
struct EscrowDataV3 {
    payer: Address,
    payee: Address,
    token: Address,
    amount: i128,
    condition_ref: String,
    status: EscrowStatus,
    releasers: Vec<Address>,
    threshold: u32,
    refund_after: Option<u64>,
    notify_payee: bool,
    requires_acceptance: bool,
    accepted_at: Option<u64>,
}

#[contracttype]
#[derive(Clone)]
enum StoredEscrowData {
    V1(EscrowDataV1),
    V2(EscrowDataV2),
    V3(EscrowDataV3),
}

#[contracttype]
enum DataKey {
    Escrow(u64),
    NextId,
    AllowedTokens,
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
    /// `condition_ref` exceeded the maximum allowed length (currently
    /// 64 bytes) — see docs/threat-model.md T10 and ROADMAP.md Phase E5.
    /// Bounded to keep storage and event costs predictable; reject at
    /// creation so no on-chain storage is wasted on an oversized ref.
    ConditionRefTooLong = 7,
    /// `token` is not in the immutable deploy-time allowlist.
    DisallowedToken = 8,
    /// The opted-in payee callback returned an error or could not be
    /// invoked. The release transaction (including its transfer) rolls back.
    CallbackFailed = 9,
    Overflow = 12,
    /// The releaser set is empty, or `threshold` is 0 or larger than the
    /// number of releasers — see docs/adr/0007.
    InvalidThreshold = 13,
    /// More than `MAX_RELEASERS` (10) addresses were supplied at creation.
    TooManyReleasers = 14,
    /// Fewer distinct approvals were supplied than the escrow's threshold,
    /// or a single releaser tried to settle a quorum escrow through the
    /// single-caller entry point.
    ThresholdNotMet = 15,
    /// The same address appeared twice in one approval list. Duplicates
    /// never count twice toward the threshold.
    DuplicateApprover = 16,
    /// The same address appeared twice in the releaser set at creation.
    DuplicateReleaser = 17,
    AcceptanceRequired = 18,
    AcceptanceNotConfigured = 19,
    AlreadyAccepted = 20,
    /// Stored escrow data is not any supported exact historical or tagged layout.
    UnsupportedStorageVersion = 21,
}

#[contract]
pub struct EscrowContract;

#[contractimpl]
impl EscrowContract {
    /// Sets the immutable token allowlist at deployment. An empty list
    /// preserves the legacy behavior and allows any token address.
    pub fn __constructor(env: Env, allowed_tokens: Vec<Address>) {
        env.storage()
            .instance()
            .set(&DataKey::AllowedTokens, &allowed_tokens);
    }

    /// Locks `amount` of `token` pulled from `payer`, held for `payee`,
    /// docs/threat-model.md T10 and ROADMAP.md Phase E5). `releaser` is the
    /// address permitted to call `release`/`refund` on this escrow
    /// (docs/adr/0002). `refund_after` is optional (docs/adr/0004).
    /// `notify_payee` opts an implementing contract payee into
    /// `on_escrow_released(escrow_id, amount)` (docs/adr/0005). The payer
    /// must authorize creation, and the payee must also authorize if
    /// `notify_payee` is true. For M-of-N releasers use
    /// `create_escrow_with_releasers`.
    pub fn create_escrow(
        env: Env,
        payer: Address,
        payee: Address,
        token: Address,
        amount: i128,
        condition_ref: String,
        releaser: Address,
        refund_after: Option<u64>,
        notify_payee: bool,
    ) -> Result<u64, Error> {
        let mut releasers = Vec::new(&env);
        releasers.push_back(releaser);
        Self::create_escrow_inner(
            &env,
            payer,
            payee,
            token,
            amount,
            condition_ref,
            releasers,
            1,
            refund_after,
            notify_payee,
            false,
        )
    }

    /// Creates an escrow with an opt-in payee acceptance gate. Existing
    /// integrations can keep using `create_escrow`, which defaults this off.
    pub fn create_escrow_with_acceptance(
        env: Env,
        payer: Address,
        payee: Address,
        token: Address,
        amount: i128,
        condition_ref: String,
        releaser: Address,
        refund_after: Option<u64>,
        requires_acceptance: bool,
    ) -> Result<u64, Error> {
        let mut releasers = Vec::new(&env);
        releasers.push_back(releaser);
        Self::create_escrow_inner(
            &env,
            payer,
            payee,
            token,
            amount,
            condition_ref,
            releasers,
            1,
            refund_after,
            false,
            requires_acceptance,
        )
    }

    /// Records the payee's acceptance for an opted-in funded escrow.
    pub fn accept(env: Env, escrow_id: u64, payee: Address) -> Result<(), Error> {
        payee.require_auth();
        let mut data = Self::load_escrow(&env, escrow_id)?;
        if data.payee != payee {
            return Err(Error::Unauthorized);
        }
        if data.status != EscrowStatus::Funded {
            return Err(Error::NotFunded);
        }
        if !data.requires_acceptance {
            return Err(Error::AcceptanceNotConfigured);
        }
        if data.accepted_at.is_some() {
            return Err(Error::AlreadyAccepted);
        }
        let accepted_at = env.ledger().timestamp();
        data.accepted_at = Some(accepted_at);
        Self::save_escrow(&env, escrow_id, &data);
        env.events()
            .publish((symbol_short!("accepted"), escrow_id), (payee, accepted_at));
        Ok(())
    }

    /// Same as `create_escrow`, but the escrow is settled by M-of-N
    /// releasers instead of one address (docs/adr/0007): `threshold`
    /// distinct addresses from `releasers` must authorize a settlement.
    /// The set is stored at creation and cannot be changed afterwards —
    /// there is no admin and no setter. Rejects an empty set, more than
    /// 10 releasers, duplicate addresses, and a threshold of 0 or one
    /// larger than the set.
    pub fn create_escrow_with_releasers(
        env: Env,
        payer: Address,
        payee: Address,
        token: Address,
        amount: i128,
        condition_ref: String,
        releasers: Vec<Address>,
        threshold: u32,
        refund_after: Option<u64>,
        notify_payee: bool,
    ) -> Result<u64, Error> {
        Self::create_escrow_inner(
            &env,
            payer,
            payee,
            token,
            amount,
            condition_ref,
            releasers,
            threshold,
            refund_after,
            notify_payee,
            false,
        )
    }

    /// Read-only status query. Errors if `escrow_id` doesn't exist.
    pub fn get_status(env: Env, escrow_id: u64) -> Result<EscrowStatus, Error> {
        let data = Self::load_escrow(&env, escrow_id)?;
        Ok(data.status)
    }

    /// Read-only accessor for everything stored about `escrow_id` — payer,
    /// payee, token, amount, `condition_ref`, status, the releaser set with
    /// its threshold, and `refund_after`. Exists so payees and integrators
    /// can check who can settle and when before relying on a `Funded`
    /// escrow (docs/adr/0004, threat model T8). Errors on an unknown id.
    pub fn get_escrow(env: Env, escrow_id: u64) -> Result<EscrowData, Error> {
        Self::load_escrow(&env, escrow_id)
    }

    /// Adds funds to a funded escrow without changing its parties or id.
    /// Only its original payer may authorize the transfer.
    pub fn top_up(env: Env, escrow_id: u64, payer: Address, amount: i128) -> Result<(), Error> {
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        payer.require_auth();
        let mut data = Self::load_escrow(&env, escrow_id)?;
        if data.payer != payer {
            return Err(Error::Unauthorized);
        }
        if data.status != EscrowStatus::Funded {
            return Err(Error::NotFunded);
        }
        let updated_amount = data.amount.checked_add(amount).ok_or(Error::Overflow)?;
        Self::transfer_in_exact(&env, &data.token, &payer, amount)?;
        data.amount = updated_amount;
        Self::save_escrow(&env, escrow_id, &data);
        env.events().publish(
            (symbol_short!("top_up"), escrow_id),
            (amount, updated_amount),
        );
        Ok(())
    }

    /// Moves the escrowed `amount` to `payee`. Only the escrow's releaser
    /// may call this — the contract enforces WHO, never WHY (ADR 0001). On
    /// an M-of-N escrow this single-caller path is only allowed when the
    /// threshold is 1; otherwise use `release_with_approvals`.
    ///
    /// Deliberately **not** gated by `refund_after` (docs/adr/0004): after
    /// the deadline the releaser can still release, racing any timeout
    /// refund — whoever lands first wins and the other fails `NotFunded`.
    pub fn release(env: Env, escrow_id: u64, caller: Address) -> Result<(), Error> {
        caller.require_auth();

        let mut data = Self::load_escrow(&env, escrow_id)?;
        Self::check_single_caller(&data, &caller)?;
        Self::check_funded(&data)?;

        Self::settle(&env, escrow_id, &mut data, EscrowStatus::Released)
    }

    /// Moves the escrowed `amount` to `payee` on behalf of an M-of-N
    /// releaser set (docs/adr/0007). Every address in `approvers` must be a
    /// releaser, appear at most once, and authorize this exact invocation;
    /// at least `threshold` distinct approvers are required. Approvals are
    /// not stored between calls, so there is nothing to clear on settlement
    /// and no approval to replay — a settled escrow fails `NotFunded`.
    pub fn release_with_approvals(
        env: Env,
        escrow_id: u64,
        approvers: Vec<Address>,
    ) -> Result<(), Error> {
        let mut data = Self::load_escrow(&env, escrow_id)?;
        Self::check_approvals(&env, &data, &approvers)?;
        Self::check_funded(&data)?;

        Self::settle(&env, escrow_id, &mut data, EscrowStatus::Released)
    }

    /// Returns the escrowed `amount` to `payer`. Same state rule as
    /// `release` (only while `Funded`), but two callers are authorised:
    ///
    /// - the escrow's releaser (docs/adr/0002), always; or
    /// - **anyone**, once `refund_after` has been reached — the timeout
    ///   refund path for a lost/unsignable releaser key (docs/adr/0004).
    ///
    /// The destination never changes: timeout or not, funds only ever go
    /// back to the stored `payer`. With no `refund_after` set, behaviour
    /// is identical to before the timeout existed — releaser only. On an
    /// M-of-N escrow the releaser path needs a threshold of 1; otherwise use
    /// `refund_with_approvals` (the timeout path stays open to anyone).
    pub fn refund(env: Env, escrow_id: u64, caller: Address) -> Result<(), Error> {
        caller.require_auth();

        let mut data = Self::load_escrow(&env, escrow_id)?;

        let timeout_passed = match data.refund_after {
            Some(deadline) => env.ledger().timestamp() >= deadline,
            None => false,
        };
        if !timeout_passed {
            Self::check_single_caller(&data, &caller)?;
        }
        Self::check_funded(&data)?;

        Self::settle(&env, escrow_id, &mut data, EscrowStatus::Refunded)
    }

    /// Returns the escrowed `amount` to `payer` on behalf of an M-of-N
    /// releaser set (docs/adr/0007). Same approval rules as
    /// `release_with_approvals`. The timeout refund path in `refund` stays
    /// available as well: once `refund_after` passes, anyone can return the
    /// funds to the payer without approvals.
    pub fn refund_with_approvals(
        env: Env,
        escrow_id: u64,
        approvers: Vec<Address>,
    ) -> Result<(), Error> {
        let mut data = Self::load_escrow(&env, escrow_id)?;
        Self::check_approvals(&env, &data, &approvers)?;
        Self::check_funded(&data)?;

        Self::settle(&env, escrow_id, &mut data, EscrowStatus::Refunded)
    }

    fn create_escrow_inner(
        env: &Env,
        payer: Address,
        payee: Address,
        token: Address,
        amount: i128,
        condition_ref: String,
        releasers: Vec<Address>,
        threshold: u32,
        refund_after: Option<u64>,
        notify_payee: bool,
        requires_acceptance: bool,
    ) -> Result<u64, Error> {
        let allowed_tokens: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::AllowedTokens)
            .unwrap_or(Vec::new(env));
        if !allowed_tokens.is_empty() && !Self::contains(&allowed_tokens, &token) {
            return Err(Error::DisallowedToken);
        }
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if let Some(deadline) = refund_after {
            if deadline <= env.ledger().timestamp() {
                return Err(Error::InvalidRefundAfter);
            }
        }
        // Bound condition_ref to keep per-escrow storage and event costs
        // predictable (threat model T10, Phase E5). 64 bytes is generous
        // for a UUID or short label while capping spam risk.
        if condition_ref.len() > MAX_CONDITION_REF_LEN {
            return Err(Error::ConditionRefTooLong);
        }
        Self::check_releaser_set(env, &releasers, threshold)?;

        payer.require_auth();
        if notify_payee {
            payee.require_auth();
        }

        Self::transfer_in_exact(env, &token, &payer, amount)?;

        let id = Self::next_id(env);
        let data = EscrowData {
            payer,
            payee,
            token,
            amount,
            condition_ref,
            status: EscrowStatus::Funded,
            releasers,
            threshold,
            refund_after,
            notify_payee,
            requires_acceptance,
            accepted_at: None,
        };
        Self::save_escrow(env, id, &data);
        Ok(id)
    }

    /// Validates the creation-time releaser set (docs/adr/0007). Run before
    /// any auth prompt or transfer so a malformed request costs the caller
    /// nothing on-chain.
    fn check_releaser_set(
        env: &Env,
        releasers: &Vec<Address>,
        threshold: u32,
    ) -> Result<(), Error> {
        if releasers.len() > MAX_RELEASERS {
            return Err(Error::TooManyReleasers);
        }
        if threshold == 0 || threshold > releasers.len() {
            return Err(Error::InvalidThreshold);
        }
        let mut seen: Vec<Address> = Vec::new(env);
        for releaser in releasers.iter() {
            if Self::contains(&seen, &releaser) {
                return Err(Error::DuplicateReleaser);
            }
            seen.push_back(releaser);
        }
        Ok(())
    }

    /// Authorizes the single-caller `release`/`refund` entry points: the
    /// caller must be a releaser, and the escrow must settle on one
    /// signature (threshold 1). A member of a larger quorum gets
    /// `ThresholdNotMet` rather than `Unauthorized`, so integrators can tell
    /// "wrong address" from "use the approvals entry point".
    fn check_single_caller(data: &EscrowData, caller: &Address) -> Result<(), Error> {
        if !Self::contains(&data.releasers, caller) {
            return Err(Error::Unauthorized);
        }
        if data.threshold != 1 {
            return Err(Error::ThresholdNotMet);
        }
        Ok(())
    }

    /// Authorizes an M-of-N settlement (docs/adr/0007): at least `threshold`
    /// distinct releasers, each of whom authorizes this exact invocation.
    /// Duplicates are rejected rather than deduplicated so a caller cannot
    /// mistake a 2-of-3 with one repeated address for a satisfied threshold.
    fn check_approvals(
        env: &Env,
        data: &EscrowData,
        approvers: &Vec<Address>,
    ) -> Result<(), Error> {
        if approvers.len() < data.threshold {
            return Err(Error::ThresholdNotMet);
        }
        let mut seen: Vec<Address> = Vec::new(env);
        for approver in approvers.iter() {
            if !Self::contains(&data.releasers, &approver) {
                return Err(Error::Unauthorized);
            }
            if Self::contains(&seen, &approver) {
                return Err(Error::DuplicateApprover);
            }
            seen.push_back(approver.clone());
            approver.require_auth();
        }
        Ok(())
    }

    /// Writes the settled state, then transfers the funds out.
    ///
    /// Checks-effects-interactions (docs/adr/0006): the status write comes
    /// before the token call, so safety doesn't rest on the host's re-entry
    /// rule alone (threat model T4). A failing transfer panics inside the
    /// token contract, which aborts and rolls back this whole invocation —
    /// including the status write — so a failed payout can never leave an
    /// escrow marked `Released`/`Refunded`.
    fn settle(
        env: &Env,
        escrow_id: u64,
        data: &mut EscrowData,
        settled: EscrowStatus,
    ) -> Result<(), Error> {
        let notify_payee = data.notify_payee && settled == EscrowStatus::Released;
        let destination = match settled {
            EscrowStatus::Released => data.payee.clone(),
            _ => data.payer.clone(),
        };
        if settled == EscrowStatus::Released
            && data.requires_acceptance
            && data.accepted_at.is_none()
        {
            return Err(Error::AcceptanceRequired);
        }
        data.status = settled;
        Self::save_escrow(env, escrow_id, data);

        let token_client = token::Client::new(env, &data.token);
        token_client.transfer(&env.current_contract_address(), &destination, &data.amount);
        if notify_payee {
            let args = (escrow_id, data.amount).into_val(env);
            let callback = env.try_invoke_contract::<(), soroban_sdk::Error>(
                &data.payee,
                &soroban_sdk::Symbol::new(env, "on_escrow_released"),
                args,
            );
            match callback {
                Ok(Ok(())) => {}
                _ => return Err(Error::CallbackFailed),
            }
        }
        Ok(())
    }

    fn load_escrow(env: &Env, escrow_id: u64) -> Result<EscrowData, Error> {
        let raw: Val = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .ok_or(Error::NotFound)?;
        if let Ok(map) = Map::<Val, Val>::try_from_val(env, &raw) {
            match map.len() {
                7 => {
                    return EscrowDataV1::try_from_val(env, &raw)
                        .map(|v| Self::from_v1(env, v))
                        .map_err(|_| Error::UnsupportedStorageVersion)
                }
                8 => {
                    return EscrowDataV2::try_from_val(env, &raw)
                        .map(|v| Self::from_v2(env, v))
                        .map_err(|_| Error::UnsupportedStorageVersion)
                }
                12 => {
                    return EscrowDataV3::try_from_val(env, &raw)
                        .map(Self::from_v3)
                        .map_err(|_| Error::UnsupportedStorageVersion)
                }
                _ => {}
            }
        }
        let stored: StoredEscrowData = raw
            .try_into_val(env)
            .map_err(|_| Error::UnsupportedStorageVersion)?;
        match stored {
            StoredEscrowData::V1(v) => Ok(Self::from_v1(env, v)),
            StoredEscrowData::V2(v) => Ok(Self::from_v2(env, v)),
            StoredEscrowData::V3(v) => Ok(Self::from_v3(v)),
        }
    }

    fn save_escrow(env: &Env, escrow_id: u64, data: &EscrowData) {
        let current = EscrowDataV3 {
            payer: data.payer.clone(),
            payee: data.payee.clone(),
            token: data.token.clone(),
            amount: data.amount,
            condition_ref: data.condition_ref.clone(),
            status: data.status.clone(),
            releasers: data.releasers.clone(),
            threshold: data.threshold,
            refund_after: data.refund_after,
            notify_payee: data.notify_payee,
            requires_acceptance: data.requires_acceptance,
            accepted_at: data.accepted_at,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), &StoredEscrowData::V3(current));
    }

    fn from_v1(env: &Env, v: EscrowDataV1) -> EscrowData {
        let mut releasers = Vec::new(env);
        releasers.push_back(v.releaser);
        EscrowData {
            payer: v.payer,
            payee: v.payee,
            token: v.token,
            amount: v.amount,
            condition_ref: v.condition_ref,
            status: v.status,
            releasers,
            threshold: 1,
            refund_after: None,
            notify_payee: false,
            requires_acceptance: false,
            accepted_at: None,
        }
    }

    fn from_v2(env: &Env, v: EscrowDataV2) -> EscrowData {
        let mut releasers = Vec::new(env);
        releasers.push_back(v.releaser);
        EscrowData {
            payer: v.payer,
            payee: v.payee,
            token: v.token,
            amount: v.amount,
            condition_ref: v.condition_ref,
            status: v.status,
            releasers,
            threshold: 1,
            refund_after: v.refund_after,
            notify_payee: false,
            requires_acceptance: false,
            accepted_at: None,
        }
    }

    fn from_v3(v: EscrowDataV3) -> EscrowData {
        EscrowData {
            payer: v.payer,
            payee: v.payee,
            token: v.token,
            amount: v.amount,
            condition_ref: v.condition_ref,
            status: v.status,
            releasers: v.releasers,
            threshold: v.threshold,
            refund_after: v.refund_after,
            notify_payee: v.notify_payee,
            requires_acceptance: v.requires_acceptance,
            accepted_at: v.accepted_at,
        }
    }

    fn check_funded(data: &EscrowData) -> Result<(), Error> {
        if data.status != EscrowStatus::Funded {
            return Err(Error::NotFunded);
        }
        Ok(())
    }

    fn contains(list: &Vec<Address>, candidate: &Address) -> bool {
        for item in list.iter() {
            if &item == candidate {
                return true;
            }
        }
        false
    }

    fn next_id(env: &Env) -> u64 {
        let id: u64 = env.storage().instance().get(&DataKey::NextId).unwrap_or(0);
        env.storage().instance().set(&DataKey::NextId, &(id + 1));
        id
    }

    fn transfer_in_exact(
        env: &Env,
        token: &Address,
        payer: &Address,
        amount: i128,
    ) -> Result<(), Error> {
        let token_client = token::Client::new(env, token);
        let contract_address = env.current_contract_address();
        let balance_before = token_client.balance(&contract_address);
        token_client.transfer(payer, &contract_address, &amount);
        let balance_after = token_client.balance(&contract_address);
        if balance_after.checked_sub(balance_before) != Some(amount) {
            return Err(Error::BalanceMismatch);
        }
        Ok(())
    }
}
