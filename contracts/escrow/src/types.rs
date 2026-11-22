//! Stored types, the `DataKey` storage keys and the pause/payee events.

use crate::*;

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

/// What one `settle_many` operation does to its escrow (issue #29).
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SettleAction {
    /// Same rules as `release`: pay the stored payee.
    Release,
    /// Same rules as `refund`: return the funds to the stored `refund_to`.
    Refund,
}

/// Direct recipient and share of a split release, in basis points.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PayeeShare {
    pub payee: Address,
    pub basis_points: u32,
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
    /// Opaque caller-supplied reference the contract stores but never
    /// interprets (docs/adr/0001). This field is **public on-chain forever**,
    /// like the rest of `EscrowData` (docs/threat-model.md T9): never put
    /// private, personal or sensitive data here. Pass an opaque, meaningless
    /// id such as a UUID or an internal record id.
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
    /// Direct release recipients; ordinary escrows store one 10,000-bps share.
    pub payees: Vec<PayeeShare>,
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
    /// Optional protocol fee recipient, set once at `create_escrow` time
    /// and paid at release (never on refund) — see docs/adr/0010. Stored
    /// as one (recipient, bps) pair in two fields so both are always set
    /// together or not at all (creation-time rule, `InvalidFee`
    /// otherwise). `None` (with no bps) means no fee: the payee receives
    /// the full `amount`, exactly as before this field existed.
    pub fee_recipient: Option<Address>,
    /// Fee rate in basis points of `amount` (capped at [`MAX_FEE_BPS`]
    /// = 10 %), taken once at release, rounded **down** with the
    /// remainder to the payee — see docs/adr/0010.
    pub fee_bps: Option<u32>,
    /// Optional attester key (ed25519 public key) for attestation-based
    /// release (Phase E5, issue #42). `None` means the escrow can only
    /// be released by its releaser(s). Set once at creation, never
    /// changed.
    pub attester: Option<BytesN<32>>,
}

/// Identifies voluntary refunds started by the escrow's stored payee.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PayeeRefunded {
    #[topic]
    pub escrow_id: u64,
    #[topic]
    pub payer: Address,
    #[topic]
    pub payee: Address,
    pub amount: i128,
}
/// Maximum `fee_bps`: 1 000 basis points out of [`BASIS_POINTS`] 10 000
/// = 10 %. A platform fee fixed at creation must be transparent but
/// cannot be the arrangement itself — see docs/adr/0010.
pub const MAX_FEE_BPS: u32 = 1_000;
/// Maximum direct recipients for one escrow release.
pub const MAX_PAYEES: u32 = 8;
/// 10 000 basis points = 100 %.
pub(crate) const BASIS_POINTS: i128 = 10_000;
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

/// A recurring funding schedule (issue #115, ADR 0015): the payer
/// records the terms once, then any keeper funds one period at a time
/// with `fund_next`, each period becoming a normal escrow. The payer's
/// SEP-41 allowance caps what can ever be pulled; cancelling stops
/// future periods without touching escrows already created.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecurringSchedule {
    pub payer: Address,
    pub payee: Address,
    pub token: Address,
    /// Amount pulled for each period.
    pub amount: i128,
    /// Stored verbatim on every period escrow (same rule as
    /// `EscrowData.condition_ref`: opaque, public on-chain forever).
    pub condition_ref: String,
    /// Single releaser of every period escrow.
    pub releaser: Address,
    /// Relative refund window, in seconds, applied to each period escrow
    /// when it is funded: the period escrow's `refund_after` is the
    /// ledger timestamp at funding plus this window. `None` means no
    /// refund deadline. Relative on purpose: an absolute deadline stored
    /// at creation would pass while periods remain, and every later
    /// `fund_next` would fail the creation path's `refund_after <= now`
    /// check, so the schedule could never complete.
    pub refund_after_seconds: Option<u64>,
    /// Seconds between period due times.
    pub period_seconds: u64,
    /// How many periods the schedule funds in total.
    pub total_periods: u32,
    /// Periods already funded.
    pub periods_funded: u32,
    /// Ledger timestamp the next period becomes due.
    pub next_due: u64,
    /// Set by `cancel_schedule`; a cancelled schedule never funds again.
    pub cancelled: bool,
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

/// A stream vests linearly from `start` through `end`; an optional cliff
/// delays availability until its timestamp.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VestingSchedule {
    pub start: u64,
    pub end: u64,
    pub cliff: Option<u64>,
}

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
pub enum DataKey {
    Escrow(u64),
    NextId,
    Status(u64),
    AllowedTokens,
    /// The one address allowed to `pause`/`unpause` — set once by
    /// `__constructor`, never changeable afterwards (docs/adr/0011).
    PauseAdmin,
    /// The emergency-pause flag. Absent/false = normal operation; only the
    /// deposit entry points read it (docs/adr/0011).
    Paused,
    /// Pooled escrows only (issue #113): immutable funding config.
    /// Soroban encodes enum variants by name, so appending these two
    /// variants does not disturb any existing storage entry.
    Pooled(u64),
    /// Pooled escrows only (issue #113): one record per contributor.
    Contribution(u64, Address),
    /// Issue #39: total outstanding liability for one token, i.e. the sum
    /// of `amount` over every escrow in that token whose status is
    /// `Funded`. Appended last, so existing entries keep their encoding.
    Liability(Address),
    /// Streamed escrows only (issue #44): immutable vesting schedule.
    Vesting(u64),
    /// Streamed escrows only (issue #44): total paid to the payee so far.
    Withdrawn(u64),
    /// Streamed escrows only (issue #44): immutable original amount.
    TotalAmount(u64),
    /// Issue #115: a recurring funding schedule (ADR 0015).
    RecurringSchedule(u64),
    /// Issue #115: next schedule id counter.
    NextScheduleId,
}

/// Emitted by `pause` (docs/adr/0011). Carries the custodian that flipped
/// the flag so integrators and monitoring can react without polling.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Paused {
    #[topic]
    pub admin: Address,
}

/// Emitted by `unpause` (docs/adr/0011).
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Unpaused {
    #[topic]
    pub admin: Address,
}
