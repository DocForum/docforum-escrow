// Soroban escrow contract.
//
// Phase E1 (see ROADMAP.md): create_escrow, get_status.
// Phase E2: release, refund. Both restricted to the escrow's releaser
// address, set at create_escrow time — see docs/adr/0002 for why a
// per-escrow releaser was chosen over a single contract-level admin.
// Phase E4 (issue #11): optional `refund_after` timeout refund — see
// docs/adr/0004. After that deadline anyone may refund, but only back to
// the payer, so a lost `releaser` key can no longer lock funds forever.
// Phase E5 (issue #28): optional `refund_to` — a refund destination that
// differs from the funder (`payer`), fixed at creation with the funder's
// auth and used by every refund path; see docs/adr/0009.
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
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, Env, IntoVal,
    String, Vec,
};

/// Largest allowed releaser set for one escrow. Ten covers every
/// real-world multisig shape this primitive is meant to replace
/// (2-of-3, 3-of-5, ...) while keeping `create_escrow`'s validation,
/// `get_escrow`'s payload and the settlement path's auth checks cheap and
/// bounded. See docs/adr/0007.
pub const MAX_RELEASERS: u32 = 10;

/// Maximum `condition_ref` length in bytes (threat model T10, Phase E5).
pub const MAX_CONDITION_REF_LEN: u32 = 64;

/// Maximum number of items accepted by `create_escrows` / `settle_many`
/// in a single call. Callers (including the SDK) must chunk larger
/// inputs — see docs/adr/0005.
pub const MAX_BATCH_SIZE: u32 = 50;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EscrowStatus {
    Funded,
    Released,
    Refunded,
    /// The payer withdrew the funds before the payee accepted — see
    /// docs/adr/0010. Terminal, like `Released` and `Refunded`.
    Cancelled,
}

#[contracttype]
#[derive(Clone)]
pub struct EscrowData {
    /// The funder: authorises and pays for the escrow at creation. Also
    /// the refund destination unless `refund_to` says otherwise.
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
    /// anyone — still only to `refund_to`. `None` means no timeout,
    /// behaviour identical to before this field existed — see docs/adr/0004.
    pub refund_after: Option<u64>,
    /// If true, invoke the contract payee's `on_escrow_released` hook after
    /// the payout transfer. A failed callback reverts the whole release.
    pub notify_payee: bool,
    /// Whether release requires the payee's explicit acceptance.
    pub requires_acceptance: bool,
    /// Ledger timestamp at which the payee accepted, if any.
    pub accepted_at: Option<u64>,
    /// Where **every** refund path (releaser, timeout) sends the funds.
    /// Fixed at creation under the funder's auth and never chosen at
    /// payout, so invariant I1 holds; defaults to `payer` when omitted at
    /// creation — see docs/adr/0009.
    pub refund_to: Address,
    /// Earliest ledger timestamp at which release is allowed.
    pub release_not_before: Option<u64>,
}

/// One entry of a `create_escrows` batch. Mirrors the single-escrow
/// creation parameters minus the batch-wide `payer`.
#[contracttype]
#[derive(Clone)]
pub struct CreateItem {
    pub payee: Address,
    pub token: Address,
    pub amount: i128,
    pub condition_ref: String,
    pub releaser: Address,
    pub refund_after: Option<u64>,
}

#[contracttype]
enum DataKey {
    Escrow(u64),
    NextId,
    AllowedTokens,
    ApprovedSources,
    Imported(MigrationKey),
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
    /// The new releaser cannot be the escrow contract or payee.
    InvalidReleaser = 24,
    /// `refund_to` was the escrow contract's own address — funds sent
    /// there on refund could never be moved again (docs/adr/0009).
    InvalidRefundTo = 21,
    /// The configured release time is in the past or after the refund time.
    InvalidReleaseNotBefore = 22,
    /// Release was attempted before the configured time.
    ReleaseTooEarly = 23,
    /// A batch call was passed more than `MAX_BATCH_SIZE` items — see
    /// docs/adr/0005. Callers must chunk. Appended at the end so existing
    /// discriminants keep their on-chain values.
    BatchTooLarge = 25,
}

#[contract]
pub struct EscrowContract;

#[contractimpl]
impl EscrowContract {
    /// Sets the immutable token allowlist and trusted source deployments at
    /// deployment. An empty allowlist preserves the legacy behavior and allows
    /// any token address. The source allowlist is fixed for the lifetime of the
    /// deployment because this contract has no admin or upgrade route.
    pub fn __constructor(env: Env, allowed_tokens: Vec<Address>, approved_sources: Vec<Address>) {
        env.storage()
            .instance()
            .set(&DataKey::AllowedTokens, &allowed_tokens);
        env.storage()
            .instance()
            .set(&DataKey::ApprovedSources, &approved_sources);
    }

    pub fn export_to(
        env: Env,
        escrow_id: u64,
        new_contract: Address,
        approvers: Vec<Address>,
    ) -> Result<u64, Error> {
        let mut data = Self::load(&env, escrow_id)?;
        if data.status != EscrowStatus::Funded {
            return Err(Error::MigrationNotEligible);
        }

        data.payer.require_auth();
        Self::check_approvals(&env, &data, &approvers)?;

        let payload = MigrationData {
            source_contract: env.current_contract_address(),
            escrow_id,
            destination_balance_before: token::Client::new(&env, &data.token).balance(&new_contract),
            payer: data.payer.clone(),
            payee: data.payee.clone(),
            token: data.token.clone(),
            amount: data.amount,
            condition_ref: data.condition_ref.clone(),
            status: EscrowStatus::Funded,
            releasers: data.releasers.clone(),
            threshold: data.threshold,
            refund_after: data.refund_after,
            notify_payee: data.notify_payee,
            requires_acceptance: data.requires_acceptance,
            accepted_at: data.accepted_at,
            refund_to: data.refund_to.clone(),
        };

        let source_contract = env.current_contract_address();
        let token_client = token::Client::new(&env, &data.token);
        token_client.transfer(&source_contract, &new_contract, &data.amount);

        let import_result = env.try_invoke_contract::<u64, soroban_sdk::Error>(
            &new_contract,
            &soroban_sdk::Symbol::new(&env, "import_from"),
            (source_contract, payload).into_val(&env),
        );
        let imported_id = match import_result {
            Ok(Ok(id)) => id,
            Ok(Err(_)) | Err(_) => return Err(Error::MigrationFailed),
        };

        data.status = EscrowStatus::Migrated;
        env.storage().persistent().set(&DataKey::Escrow(escrow_id), &data);
        env.storage().persistent().set(
            &DataKey::Imported(MigrationKey {
                source_contract: env.current_contract_address(),
                source_id: escrow_id,
            }),
            &true,
        );
        Ok(imported_id)
    }

    pub fn import_from(
        env: Env,
        source_contract: Address,
        migration: MigrationData,
    ) -> Result<u64, Error> {
        source_contract.require_auth();
        if source_contract == env.current_contract_address() {
            return Err(Error::UnapprovedSource);
        }

        let approved: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::ApprovedSources)
            .unwrap_or(Vec::new(&env));
        if !Self::contains(&approved, &source_contract) {
            return Err(Error::UnapprovedSource);
        }
        if migration.source_contract != source_contract {
            return Err(Error::InvalidMigration);
        }
        if migration.status != EscrowStatus::Funded {
            return Err(Error::MigrationNotEligible);
        }
        if migration.amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let allowed_tokens: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::AllowedTokens)
            .unwrap_or(Vec::new(&env));
        if !allowed_tokens.is_empty() && !Self::contains(&allowed_tokens, &migration.token) {
            return Err(Error::DisallowedToken);
        }
        if migration.condition_ref.len() > MAX_CONDITION_REF_LEN {
            return Err(Error::ConditionRefTooLong);
        }
        Self::check_releaser_set(&env, &migration.releasers, migration.threshold)?;
        if migration.refund_to == env.current_contract_address() {
            return Err(Error::InvalidRefundTo);
        }

        let import_key = MigrationKey {
            source_contract: source_contract.clone(),
            source_id: migration.escrow_id,
        };
        if env.storage().persistent().has(&DataKey::Imported(import_key.clone())) {
            return Err(Error::AlreadyMigrated);
        }

        let token_client = token::Client::new(&env, &migration.token);
        let destination_balance = token_client.balance(&env.current_contract_address());
        let expected_balance = migration
            .destination_balance_before
            .checked_add(migration.amount)
            .ok_or(Error::Overflow)?;
        if destination_balance != expected_balance {
            return Err(Error::BalanceMismatch);
        }

        let destination_id = Self::next_id(&env);
        let imported = EscrowData {
            payer: migration.payer,
            payee: migration.payee,
            token: migration.token,
            amount: migration.amount,
            condition_ref: migration.condition_ref,
            status: EscrowStatus::Funded,
            releasers: migration.releasers,
            threshold: migration.threshold,
            refund_after: migration.refund_after,
            notify_payee: migration.notify_payee,
            requires_acceptance: migration.requires_acceptance,
            accepted_at: migration.accepted_at,
            refund_to: migration.refund_to,
        };
        env.storage().persistent().set(&DataKey::Escrow(destination_id), &imported);
        env.storage().persistent().set(&DataKey::Imported(import_key), &true);
        Ok(destination_id)
    }

    /// Locks `amount` of `token` pulled from `payer`, held for `payee`,
    /// docs/threat-model.md T10 and ROADMAP.md Phase E5). `releaser` is the
    /// address permitted to call `release`/`refund` on this escrow
    /// (docs/adr/0002). `refund_after` is optional (docs/adr/0004).
    /// `notify_payee` opts an implementing contract payee into
    /// `on_escrow_released(escrow_id, amount)` (docs/adr/0005). The payer
    /// must authorize creation, and the payee must also authorize if
    /// `notify_payee` is true. `refund_to` is the optional refund
    /// destination for a sponsored escrow where the funder (`payer`) is
    /// not who should get the money back (docs/adr/0009): `None` means
    /// `payer`; it may not be this contract's own address, and the
    /// `payer`'s auth on this call covers it. For M-of-N releasers use
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
        refund_to: Option<Address>,
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
            refund_to,
            None,
        )
    }

    /// Creates a single-releaser escrow with an optional earliest release time.
    /// Release is allowed at the configured timestamp.
    pub fn create_escrow_release_time(
        env: Env,
        payer: Address,
        payee: Address,
        token: Address,
        amount: i128,
        condition_ref: String,
        releaser: Address,
        refund_after: Option<u64>,
        notify_payee: bool,
        refund_to: Option<Address>,
        release_not_before: Option<u64>,
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
            refund_to,
            release_not_before,
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
        refund_to: Option<Address>,
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
            refund_to,
            None,
        )
    }

    /// Records the payee's acceptance for an opted-in funded escrow.
    pub fn accept(env: Env, escrow_id: u64, payee: Address) -> Result<(), Error> {
        payee.require_auth();
        let mut data: EscrowData = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .ok_or(Error::NotFound)?;
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
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), &data);
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
        refund_to: Option<Address>,
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
            refund_to,
            None,
        )
    }

    /// Batch version of `create_escrow`. Creates one escrow per item, in
    /// input order, and returns the new ids in the same order as `items`.
    /// `payer` authorizes once for the whole call. Fails atomically: if
    /// any item is invalid (bad amount, past `refund_after`, oversized
    /// `condition_ref`, short-delivering token) the whole call reverts and
    /// no escrows are created.
    ///
    /// `items.len()` must be `<= MAX_BATCH_SIZE` — see docs/adr/0005.
    pub fn create_escrows(
        env: Env,
        payer: Address,
        items: Vec<CreateItem>,
    ) -> Result<Vec<u64>, Error> {
        if items.len() > MAX_BATCH_SIZE {
            return Err(Error::BatchTooLarge);
        }

        let mut ids: Vec<u64> = Vec::new(&env);
        for item in items.iter() {
            let mut releasers = Vec::new(&env);
            releasers.push_back(item.releaser.clone());
            let id = Self::create_escrow_inner(
                &env,
                payer.clone(),
                item.payee.clone(),
                item.token.clone(),
                item.amount,
                item.condition_ref.clone(),
                releasers,
                1,
                item.refund_after,
                false,
                false,
                None,
                None,
            )?;
            ids.push_back(id);
        }
        Ok(ids)
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

    /// Read-only accessor for everything stored about `escrow_id` — payer,
    /// payee, token, amount, `condition_ref`, status, the releaser set with
    /// its threshold, `refund_after` and `refund_to`. Exists so payees and
    /// integrators can check who can settle, when, and where a refund goes
    /// before relying on a `Funded` escrow (docs/adr/0004, threat model T8).
    /// Errors on an unknown id.
    pub fn get_escrow(env: Env, escrow_id: u64) -> Result<EscrowData, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .ok_or(Error::NotFound)
    }

    /// Rotates a funded escrow's releaser. Both the current releaser and
    /// payer must authorize the change; the payer's consent prevents a
    /// compromised releaser from silently appointing an attacker. The
    /// replacement cannot be the contract itself or the payee.
    pub fn rotate_releaser(
        env: Env,
        escrow_id: u64,
        caller: Address,
        new_releaser: Address,
    ) -> Result<(), Error> {
        caller.require_auth();
        let mut data: EscrowData = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .ok_or(Error::NotFound)?;

        if data.threshold != 1 {
            return Err(Error::ThresholdNotMet);
        }
        let previous_releaser = data.releasers.get(0).ok_or(Error::InvalidReleaser)?;
        if caller != previous_releaser {
            return Err(Error::Unauthorized);
        }
        if data.status != EscrowStatus::Funded {
            return Err(Error::NotFunded);
        }
        if new_releaser == env.current_contract_address() || new_releaser == data.payee {
            return Err(Error::InvalidReleaser);
        }

        data.payer.require_auth();
        let mut releasers = Vec::new(&env);
        releasers.push_back(new_releaser.clone());
        data.releasers = releasers;
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), &data);
        env.events().publish(
            (symbol_short!("rotate"), escrow_id),
            (previous_releaser, new_releaser),
        );
        Ok(())
    }

    /// Adds funds to a funded escrow without changing its parties or id.
    /// Only its original payer may authorize the transfer.
    pub fn top_up(env: Env, escrow_id: u64, payer: Address, amount: i128) -> Result<(), Error> {
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        payer.require_auth();
        let mut data: EscrowData = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .ok_or(Error::NotFound)?;
        if data.payer != payer {
            return Err(Error::Unauthorized);
        }
        if data.status != EscrowStatus::Funded {
            return Err(Error::NotFunded);
        }
        let updated_amount = data.amount.checked_add(amount).ok_or(Error::Overflow)?;
        Self::transfer_in_exact(&env, &data.token, &payer, amount)?;
        data.amount = updated_amount;
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), &data);
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

        let mut data = Self::load(&env, escrow_id)?;
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
        let mut data = Self::load(&env, escrow_id)?;
        Self::check_approvals(&env, &data, &approvers)?;
        Self::check_funded(&data)?;

        Self::settle(&env, escrow_id, &mut data, EscrowStatus::Released)
    }

    /// Batch version of `release`: releases each escrow in `escrow_ids` in
    /// order on behalf of `caller`, which must be a releaser of every one
    /// of them. Returns a per-op result vector aligned with `escrow_ids`:
    /// `Ok(())` for a successful release, `Err(e)` for one the contract
    /// rejected (unknown id, not funded, caller not a releaser, before
    /// `release_not_before`). A rejected op does not stop the rest — the
    /// caller can inspect the vector and retry only the failures.
    ///
    /// `escrow_ids.len()` must be `<= MAX_BATCH_SIZE` — see docs/adr/0005.
    pub fn settle_many(
        env: Env,
        caller: Address,
        escrow_ids: Vec<u64>,
    ) -> Result<Vec<Result<(), Error>>, Error> {
        if escrow_ids.len() > MAX_BATCH_SIZE {
            return Err(Error::BatchTooLarge);
        }

        let mut results: Vec<Result<(), Error>> = Vec::new(&env);
        for escrow_id in escrow_ids.iter() {
            results.push_back(Self::release(env.clone(), escrow_id, caller.clone()));
        }
        Ok(results)
    }

    /// Returns the escrowed `amount` to the escrow's `refund_to` (the
    /// `payer` unless a different destination was fixed at creation —
    /// docs/adr/0006). Same state rule as
    /// `release` (only while `Funded`), but two callers are authorised:
    ///
    /// - the escrow's releaser (docs/adr/0002), always; or
    /// - **anyone**, once `refund_after` has been reached — the timeout
    ///   refund path for a lost/unsignable releaser key (docs/adr/0004).
    ///
    /// The destination never changes: timeout or not, funds only ever go
    /// to the stored `refund_to`, which no caller can influence. With no
    /// `refund_after` set, behaviour is identical to before the timeout
    /// existed — releaser only. On an M-of-N escrow the releaser path needs
    /// a threshold of 1; otherwise use `refund_with_approvals` (the timeout
    /// path stays open to anyone).
    pub fn refund(env: Env, escrow_id: u64, caller: Address) -> Result<(), Error> {
        caller.require_auth();

        let mut data = Self::load(&env, escrow_id)?;

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

    /// Lets the payer take the funds back **before the payee accepts**
    /// (docs/adr/0010): returns the escrowed `amount` to `refund_to` (the
    /// `payer` unless a sponsor destination was fixed at creation, ADR
    /// 0009) and marks the escrow `Cancelled`. Allowed only while **all**
    /// hold:
    ///
    /// - `payer` is the escrow's stored payer and authorizes the call;
    /// - the escrow is still `Funded` (`NotFunded` otherwise — never after
    ///   a release, refund or earlier cancel);
    /// - it was created with `requires_acceptance`
    ///   (`AcceptanceNotConfigured` otherwise — without the gate there is
    ///   no acceptance step to race, so no cancel window exists);
    /// - the payee has not accepted (`AlreadyAccepted` otherwise).
    ///
    /// The destination is read from storage, so invariant I1 is unchanged.
    /// Payees: do not rely on a `requires_acceptance` escrow until you
    /// have called `accept`. `accept` and `cancel` race on one ledger
    /// state: whichever lands first wins and the other fails.
    pub fn cancel(env: Env, escrow_id: u64, payer: Address) -> Result<(), Error> {
        payer.require_auth();

        let mut data = Self::load(&env, escrow_id)?;
        if payer != data.payer {
            return Err(Error::Unauthorized);
        }
        Self::check_funded(&data)?;
        if !data.requires_acceptance {
            return Err(Error::AcceptanceNotConfigured);
        }
        if data.accepted_at.is_some() {
            return Err(Error::AlreadyAccepted);
        }

        Self::settle(&env, escrow_id, &mut data, EscrowStatus::Cancelled)
    }

    /// Returns the escrowed `amount` to `refund_to` on behalf of an M-of-N
    /// releaser set (docs/adr/0007). Same approval rules as
    /// `release_with_approvals`. The timeout refund path in `refund` stays
    /// available as well: once `refund_after` passes, anyone can return the
    /// funds to the payer without approvals.
    pub fn refund_with_approvals(
        env: Env,
        escrow_id: u64,
        approvers: Vec<Address>,
    ) -> Result<(), Error> {
        let mut data = Self::load(&env, escrow_id)?;
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
        refund_to: Option<Address>,
        release_not_before: Option<u64>,
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
        if let Some(release_time) = release_not_before {
            if release_time < env.ledger().timestamp()
                || refund_after.is_some_and(|refund_time| release_time > refund_time)
            {
                return Err(Error::InvalidReleaseNotBefore);
            }
        }
        // Bound condition_ref to keep per-escrow storage and event costs
        // predictable (threat model T10, Phase E5). 64 bytes is generous
        // for a UUID or short label while capping spam risk.
        if condition_ref.len() > MAX_CONDITION_REF_LEN {
            return Err(Error::ConditionRefTooLong);
        }
        Self::check_releaser_set(env, &releasers, threshold)?;
        let refund_to = refund_to.unwrap_or_else(|| payer.clone());
        if refund_to == env.current_contract_address() {
            return Err(Error::InvalidRefundTo);
        }

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
            refund_to,
            release_not_before,
        };
        env.storage().persistent().set(&DataKey::Escrow(id), &data);
        Self::publish_state(env, symbol_short!("created"), id, &data);
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
        if settled == EscrowStatus::Released
            && data
                .release_not_before
                .is_some_and(|release_time| env.ledger().timestamp() < release_time)
        {
            return Err(Error::ReleaseTooEarly);
        }
        let notify_payee = data.notify_payee && settled == EscrowStatus::Released;
        let destination = match settled {
            EscrowStatus::Released => data.payee.clone(),
            _ => data.refund_to.clone(),
        };
        if settled == EscrowStatus::Released
            && data.requires_acceptance
            && data.accepted_at.is_none()
        {
            return Err(Error::AcceptanceRequired);
        }
        data.status = settled;
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), data);

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
        let action = match &data.status {
            EscrowStatus::Funded => symbol_short!("created"),
            EscrowStatus::Released => symbol_short!("released"),
            EscrowStatus::Refunded => symbol_short!("refunded"),
            EscrowStatus::Cancelled => symbol_short!("cancelled"),
        };
        Self::publish_state(env, action, escrow_id, data);
        Ok(())
    }

    /// Emits a complete state snapshot for indexers, with releaser sets
    /// preserved for M-of-N escrows.
    fn publish_state(env: &Env, action: soroban_sdk::Symbol, id: u64, data: &EscrowData) {
        let status = match &data.status {
            EscrowStatus::Funded => symbol_short!("Funded"),
            EscrowStatus::Released => symbol_short!("Released"),
            EscrowStatus::Refunded => symbol_short!("Refunded"),
            EscrowStatus::Cancelled => symbol_short!("Cancelled"),
        };
        env.events().publish(
            (symbol_short!("ESCROW"), action, id),
            (
                data.payer.clone(),
                data.payee.clone(),
                data.token.clone(),
                data.amount,
                data.condition_ref.clone(),
                data.releasers.clone(),
                data.threshold,
                data.refund_after,
                data.notify_payee,
                data.requires_acceptance,
                data.accepted_at,
                status,
            ),
        );
    }

    fn load(env: &Env, escrow_id: u64) -> Result<EscrowData, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .ok_or(Error::NotFound)
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
