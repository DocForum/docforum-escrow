//! Stored types, the `DataKey` storage keys and the pause/payee events.

use crate::*;

pub use docforum_escrow_interface::{EscrowData, EscrowStatus, PayeeShare};

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
