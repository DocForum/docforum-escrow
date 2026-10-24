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
// Phase E5 (issue #48): settled escrows are reclaimed to a one-field
// tombstone; the settlement event is the audit record — see docs/adr/0012.
// Phase E5 (issue #119): an escrow can instead be created with an M-of-N
// releaser set (`create_escrow_with_releasers`) — see docs/adr/0007.
// Single-releaser escrows are stored as a one-address set with threshold 1
// and behave exactly as before.
// Phase E5 (issue #113): pooled escrows funded by multiple payers —
// `create_pooled_escrow` + `contribute` + pull-based `claim_refund`, see
// docs/adr/0011. Pooled escrows add two storage records (funding config,
// per-payer contributions); `EscrowData` and every pre-existing entry
// point keep their exact meaning.
//
// Hard rule (see ARCHITECTURE_ESSENTIALS.md / docs/adr/0001): the contract
// enforces WHO may act, not WHY. `condition_ref` is opaque — the contract
// never interprets it. Keep it that way; domain logic belongs in the
// consuming application (docforum-core), never here.
#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, Env,
    IntoVal, String, Vec,
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
/// Immutable funding configuration of a pooled escrow (issue #113,
/// docs/adr/0011). Existence of this record under `DataKey::Pooled(id)` is
/// what makes an escrow "pooled"; the aggregate funded amount lives in
/// `EscrowData.amount` (one source of truth shared with `settle()`).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PooledData {
    /// Total the contributors must reach for release to become possible.
    /// Strictly positive, fixed at creation, never changed afterwards.
    pub funding_target: i128,
    /// Unix seconds until which `contribute` is accepted. When it passes
    /// with the target unmet, the round has failed: contributions are
    /// frozen forever and every contributor may pull their exact recorded
    /// amount back with `claim_refund` — the escrow can never be released.
    pub funding_deadline: u64,
}

/// One payer's record on a pooled escrow (issue #113, docs/adr/0011).
/// `amount` accumulates every accepted contribution from that payer;
/// `refunded` is the claim-completion marker that makes a second payout
/// impossible. Records are only ever written by `contribute` and
/// `claim_refund`, each under the contributor's own authorization.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Contribution {
    pub amount: i128,
    pub refunded: bool,
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

/// The only state kept for a settled escrow (docs/adr/0012). Its parties,
/// token, amount and releasers live in the settlement event
/// (`publish_state`), not in persistent storage.
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
    AllowedTokens,
    /// Pooled escrows only (issue #113): immutable funding config.
    /// Soroban encodes enum variants by name, so appending these two
    /// variants does not disturb any existing storage entry.
    Pooled(u64),
    /// Pooled escrows only (issue #113): one record per contributor.
    Contribution(u64, Address),
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
    /// `contribute`/`claim_refund`/`get_contribution` on a non-pooled
    /// escrow, or `get_pooled` on a non-pooled/unknown id — see
    /// docs/adr/0011.
    NotPooled = 26,
    /// A contribution arrived after the pooled escrow's funding deadline.
    /// Late contributions can never be accepted: the round's outcome
    /// (release vs per-contributor refunds) is fixed at the deadline.
    FundingDeadlinePassed = 27,
    /// A contribution would push the pooled total past the funding target
    /// (overfunding is rejected, not accepted), the target is already met,
    /// or a refund was claimed on a fully funded pooled escrow.
    FundingTargetReached = 28,
    /// `release` on a pooled escrow whose funded total is below the
    /// funding target — partial funding is never releasable.
    FundingIncomplete = 29,
    /// `claim_refund` before the funding deadline passed on a round that
    /// is still (or now fully) funded. Claims open only for a failed round.
    RefundNotOpen = 30,
    /// The same contributor tried to claim a refund twice.
    AlreadyRefunded = 31,
    /// `claim_refund` by an address with no recorded contribution.
    NoContribution = 32,
    /// `refund`/`refund_with_approvals`/`cancel`/`top_up` on a pooled
    /// escrow: pushing the whole pooled total to one address would violate
    /// per-contributor accounting. Pooled refunds are pull-based
    /// (`claim_refund`); pooled funding is `contribute`-only.
    NotSupportedForPooled = 33,
    /// The funding deadline was not strictly in the future at creation.
    InvalidFundingDeadline = 34,
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
        let mut data = Self::load(&env, escrow_id)?;
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


    /// Read-only status query. Answers for settled escrows too, from the
    /// tombstone left on settlement (docs/adr/0012), so `NotFound` means
    /// exactly one thing: this id was never created.
    pub fn get_status(env: Env, escrow_id: u64) -> Result<EscrowStatus, Error> {
        if let Some(data) = env
            .storage()
            .persistent()
            .get::<_, EscrowData>(&DataKey::Escrow(escrow_id))
        {
            return Ok(data.status);
        }
        env.storage()
            .persistent()
            .get::<_, SettledEscrow>(&DataKey::SettledEscrow(escrow_id))
            .map(|tombstone| tombstone.status)
            .ok_or(Error::NotFound)
    }

    /// Read-only accessor for everything stored about `escrow_id` — payer,
    /// payee, token, amount, `condition_ref`, status, the releaser set with
    /// its threshold, `refund_after` and `refund_to`. Exists so payees and
    /// integrators can check who can settle, when, and where a refund goes
    /// before relying on a `Funded` escrow (docs/adr/0004, threat model T8).
    /// Only `Funded` escrows have a full record: once settled it is reclaimed
    /// (docs/adr/0012) and this returns `NotFound` — use `get_status` for a
    /// settled id and the settlement event for its history.
    pub fn get_escrow(env: Env, escrow_id: u64) -> Result<EscrowData, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .ok_or(Error::NotFound)
    }

    /// Creates a pooled escrow funded by many payers (issue #113,
    /// docs/adr/0011). `creator` sets the deal — payee, token, releaser,
    /// opaque `condition_ref`, an explicit `funding_target` (> 0) and a
    /// `funding_deadline` (unix seconds, strictly in the future) — but
    /// funds nothing at creation: `EscrowData.amount` starts at 0 and grows
    /// as contributors call `contribute`. Release becomes possible only
    /// once contributions reach the target exactly; if the deadline passes
    /// first, the round has failed and every contributor pulls their own
    /// recorded amount back with `claim_refund`. `creator` is stored as
    /// the escrow's `payer` (co-authorization for `rotate_releaser` only)
    /// and as the `refund_to` placeholder; no push refund path exists for
    /// pooled escrows. No `refund_after`, no acceptance gate, no callback:
    /// pooled settlement reuses the plain releaser/threshold rules.
    pub fn create_pooled_escrow(
        env: Env,
        creator: Address,
        payee: Address,
        token: Address,
        funding_target: i128,
        condition_ref: String,
        releaser: Address,
        funding_deadline: u64,
    ) -> Result<u64, Error> {
        // Validate everything before any auth prompt so a malformed
        // request costs the caller nothing on-chain (same convention as
        // `create_escrow_inner`).
        let allowed_tokens: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::AllowedTokens)
            .unwrap_or(Vec::new(&env));
        if !allowed_tokens.is_empty() && !Self::contains(&allowed_tokens, &token) {
            return Err(Error::DisallowedToken);
        }
        if funding_target <= 0 {
            return Err(Error::InvalidAmount);
        }
        if funding_deadline <= env.ledger().timestamp() {
            return Err(Error::InvalidFundingDeadline);
        }
        if condition_ref.len() > MAX_CONDITION_REF_LEN {
            return Err(Error::ConditionRefTooLong);
        }
        let mut releasers = Vec::new(&env);
        releasers.push_back(releaser);
        Self::check_releaser_set(&env, &releasers, 1)?;

        creator.require_auth();

        let id = Self::next_id(&env);
        let data = EscrowData {
            payer: creator.clone(),
            payee,
            token,
            // Grows with accepted contributions; release pays exactly
            // this pooled total.
            amount: 0,
            condition_ref,
            status: EscrowStatus::Funded,
            releasers,
            threshold: 1,
            // No push timeout exists for pooled escrows, so the field is
            // inert; kept for read-shape compatibility.
            refund_after: None,
            notify_payee: false,
            requires_acceptance: false,
            accepted_at: None,
            // Never used by a payout: pooled refunds are pull-based per
            // contributor. Stored so every `EscrowData` invariant holds.
            refund_to: creator,
            release_not_before: None,
        };
        env.storage().persistent().set(&DataKey::Escrow(id), &data);
        env.storage().persistent().set(
            &DataKey::Pooled(id),
            &PooledData {
                funding_target,
                funding_deadline,
            },
        );
        Self::publish_state(&env, symbol_short!("created"), id, &data);
        Ok(id)
    }

    /// Adds `amount` to a pooled escrow from `payer` (issue #113,
    /// docs/adr/0011). Permissionless — anyone may fund — but every
    /// contribution:
    /// - must be a positive amount (`InvalidAmount`);
    /// - is accepted only while the escrow is `Funded` and the ledger
    ///   timestamp is strictly before the funding deadline
    ///   (`FundingDeadlinePassed` after it — late money can never change a
    ///   round's outcome);
    /// - may not push the pooled total past the funding target
    ///   (`FundingTargetReached` — overfunding is rejected, not refunded);
    /// - is pulled from `payer` under `payer.require_auth()` and verified
    ///   with the same exact balance-delta check as creation
    ///   (`BalanceMismatch` if the contract's balance didn't rise by
    ///   exactly `amount`);
    /// - is recorded against `payer` only, accumulating across repeated
    ///   contributions and never touching other payers' records.
    /// Accounting is updated only after the transfer is verified, so a
    /// failed contribution records nothing (invariant I4).
    pub fn contribute(env: Env, escrow_id: u64, payer: Address, amount: i128) -> Result<(), Error> {
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let mut data: EscrowData = Self::load(&env, escrow_id)?;
        let pooled = Self::pooled_data(&env, escrow_id)?;
        Self::check_funded(&data)?;
        if env.ledger().timestamp() >= pooled.funding_deadline {
            return Err(Error::FundingDeadlinePassed);
        }
        let remaining = pooled
            .funding_target
            .checked_sub(data.amount)
            .ok_or(Error::Overflow)?;
        if amount > remaining {
            return Err(Error::FundingTargetReached);
        }

        payer.require_auth();
        Self::transfer_in_exact(&env, &data.token, &payer, amount)?;

        let key = DataKey::Contribution(escrow_id, payer.clone());
        let mut contribution: Contribution = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or(Contribution {
                amount: 0,
                refunded: false,
            });
        contribution.amount = contribution.amount.checked_add(amount).ok_or(Error::Overflow)?;
        let funded = data.amount.checked_add(amount).ok_or(Error::Overflow)?;
        data.amount = funded;
        env.storage().persistent().set(&key, &contribution);
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), &data);
        env.events().publish(
            (symbol_short!("contrib"), escrow_id),
            (payer, amount, funded),
        );
        Ok(())
    }

    /// Pull-based refund (issue #113, docs/adr/0011): pays `contributor`
    /// exactly the amount recorded against that address, once. Available
    /// only for a *failed* funding round — the funding deadline has passed
    /// with the pooled total still below the target (`RefundNotOpen`
    /// otherwise) — and only while the escrow has not been released
    /// (`NotFunded` afterwards: released funds can never be claimed).
    /// Each claim is O(1) work — no path iterates contributors — and its
    /// own authorization: no one can claim on another contributor's
    /// behalf (`NoContribution` for an address with no record), a second
    /// claim fails `AlreadyRefunded`, and the order of claims can never
    /// change anyone's entitlement. Checks-effects-interactions: the
    /// `refunded` flag and the pooled total are written before the
    /// transfer, and a failing transfer rolls the whole claim back.
    pub fn claim_refund(
        env: Env,
        escrow_id: u64,
        contributor: Address,
    ) -> Result<(), Error> {
        contributor.require_auth();

        let mut data: EscrowData = Self::load(&env, escrow_id)?;
        let pooled = Self::pooled_data(&env, escrow_id)?;
        Self::check_funded(&data)?;
        if env.ledger().timestamp() < pooled.funding_deadline {
            return Err(Error::RefundNotOpen);
        }
        if data.amount >= pooled.funding_target {
            // The round succeeded: release, don't refund.
            return Err(Error::FundingTargetReached);
        }

        let key = DataKey::Contribution(escrow_id, contributor.clone());
        let mut contribution: Contribution = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NoContribution)?;
        if contribution.refunded {
            return Err(Error::AlreadyRefunded);
        }
        let refund_amount = contribution.amount;

        // Effects before interaction: mark the claim spent and decrement
        // the pooled total first, so a failed transfer rolls back
        // atomically and can never double-pay (invariant I3).
        contribution.refunded = true;
        data.amount = data.amount.checked_sub(refund_amount).ok_or(Error::Overflow)?;
        env.storage().persistent().set(&key, &contribution);
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), &data);

        let token_client = token::Client::new(&env, &data.token);
        token_client.transfer(
            &env.current_contract_address(),
            &contributor,
            &refund_amount,
        );
        env.events().publish(
            (symbol_short!("claimed"), escrow_id),
            (contributor, refund_amount),
        );
        Ok(())
    }

    /// Read-only: the immutable funding config of a pooled escrow. The
    /// aggregate funded amount is the escrow's `amount` from `get_escrow`;
    /// a round is failed when `now >= funding_deadline` and `amount <
    /// funding_target` (then `claim_refund` is open to each contributor).
    /// Errors `NotPooled` on a non-pooled or unknown id.
    pub fn get_pooled(env: Env, escrow_id: u64) -> Result<PooledData, Error> {
        Self::pooled_data(&env, escrow_id)
    }

    /// Read-only: one contributor's record on a pooled escrow — the exact
    /// amount they can claim back from a failed round, and whether it has
    /// already been claimed. `None` means the address never contributed.
    /// Errors `NotFound` on an unknown id and `NotPooled` on a
    /// non-pooled escrow.
    pub fn get_contribution(
        env: Env,
        escrow_id: u64,
        contributor: Address,
    ) -> Result<Option<Contribution>, Error> {
        let key = DataKey::Contribution(escrow_id, contributor);
        if !env.storage().persistent().has(&key) {
            // Distinguish "no such escrow" from "wrong escrow kind" so
            // callers can't confuse a missing record with a bad id.
            if !env.storage().persistent().has(&DataKey::Pooled(escrow_id)) {
                if env.storage().persistent().has(&DataKey::Escrow(escrow_id)) {
                    return Err(Error::NotPooled);
                }
                return Err(Error::NotFound);
            }
            return Ok(None);
        }
        Ok(env.storage().persistent().get(&key))
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
        let mut data = Self::load(&env, escrow_id)?;

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
        let mut data = Self::load(&env, escrow_id)?;
        // A pooled escrow grows only through `contribute`, which records
        // the payer and verifies the received amount (docs/adr/0011).
        // A bare top-up would raise `data.amount` without a contribution
        // record, breaking "funded == sum of unclaimed contributions".
        Self::reject_pooled(&env, escrow_id)?;
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
        Self::check_pooled_fully_funded(&env, escrow_id, &data)?;

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
        Self::check_pooled_fully_funded(&env, escrow_id, &data)?;

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
        // A pooled escrow's funds belong to its contributors until the
        // deadline decides the round; a push refund to one `refund_to`
        // would violate per-contributor accounting (docs/adr/0011).
        // Pooled refunds are pull-based: `claim_refund`.
        Self::reject_pooled(&env, escrow_id)?;

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
        // Pooled escrows have no acceptance gate to race and no push
        // refund path at all (docs/adr/0011) — contributors pull their
        // own funds after a missed funding deadline.
        Self::reject_pooled(&env, escrow_id)?;
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
        // See `refund`: pooled escrows never push refunds (docs/adr/0011).
        Self::reject_pooled(&env, escrow_id)?;
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
        if env.storage().persistent().has(&DataKey::Pooled(escrow_id)) {
            // Pooled escrows keep their full record: contributions, pull-based
            // refunds and `get_pooled` all read it after settlement, so
            // reclaiming it would change those reads (docs/adr/0012).
            env.storage()
                .persistent()
                .set(&DataKey::Escrow(escrow_id), data);
        } else {
            // Reclaim storage (docs/adr/0012): the full record is published by
            // `publish_state` below and then replaced by a one-field
            // tombstone. Written before the transfer (docs/adr/0006); a failed
            // payout or callback rolls the whole invocation back, tombstone
            // included.
            env.storage()
                .persistent()
                .remove(&DataKey::Escrow(escrow_id));
            env.storage().persistent().set(
                &DataKey::SettledEscrow(escrow_id),
                &SettledEscrow {
                    status: data.status.clone(),
                },
            );
        }

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

    /// Loads the full record of a funded escrow. A settled id answers
    /// `NotFunded` — what it returned before the record was reclaimed
    /// (docs/adr/0011) — and only a never-created id is `NotFound`.
    fn load(env: &Env, escrow_id: u64) -> Result<EscrowData, Error> {
        if let Some(data) = env.storage().persistent().get(&DataKey::Escrow(escrow_id)) {
            return Ok(data);
        }
        if env
            .storage()
            .persistent()
            .has(&DataKey::SettledEscrow(escrow_id))
        {
            return Err(Error::NotFunded);
        }
        Err(Error::NotFound)
    }

    fn check_funded(data: &EscrowData) -> Result<(), Error> {
        if data.status != EscrowStatus::Funded {
            return Err(Error::NotFunded);
        }
        Ok(())
    }

    /// Loads a pooled escrow's immutable funding config, or errors
    /// `NotPooled` for any escrow without one (issue #113, ADR 0011).
    fn pooled_data(env: &Env, escrow_id: u64) -> Result<PooledData, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Pooled(escrow_id))
            .ok_or(Error::NotPooled)
    }

    /// Rejects an entry point that must never act on a pooled escrow
    /// (push `refund`, `refund_with_approvals`, `cancel`, `top_up` — see
    /// docs/adr/0011 for why each would break per-contributor accounting).
    fn reject_pooled(env: &Env, escrow_id: u64) -> Result<(), Error> {
        if env
            .storage()
            .persistent()
            .has(&DataKey::Pooled(escrow_id))
        {
            return Err(Error::NotSupportedForPooled);
        }
        Ok(())
    }

    /// Pooled escrows release only when fully funded (issue #113): a
    /// round below its target — whatever the clock says — can never pay
    /// the payee; its funds belong to the contributors via
    /// `claim_refund` once the deadline passes. Non-pooled escrows are
    /// unaffected. Runs after the `Funded` status check, so a settled
    /// escrow still reports `NotFunded` first.
    fn check_pooled_fully_funded(
        env: &Env,
        escrow_id: u64,
        data: &EscrowData,
    ) -> Result<(), Error> {
        if let Some(pooled) = env
            .storage()
            .persistent()
            .get::<_, PooledData>(&DataKey::Pooled(escrow_id))
        {
            if data.amount != pooled.funding_target {
                return Err(Error::FundingIncomplete);
            }
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
