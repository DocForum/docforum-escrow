//! Limits and TTL constants.

/// Largest allowed releaser set for one escrow. Ten covers every
/// real-world multisig shape this primitive is meant to replace
/// (2-of-3, 3-of-5, ...) while keeping `create_escrow`'s validation,
/// `get_escrow`'s payload and the settlement path's auth checks cheap and
/// bounded. See docs/adr/0007.
pub const MAX_RELEASERS: u32 = 10;

/// Maximum `condition_ref` length in bytes (threat model T10, Phase E5).
pub const MAX_CONDITION_REF_LEN: u32 = 64;

/// Maximum number of items accepted by one `create_escrows` call. Callers
/// (including the SDK) must chunk larger inputs. Measured, not guessed: each
/// item emits a full escrow state event plus the token's transfer event, and
/// the per-transaction contract-events budget (16,384 bytes on Mainnet) is
/// the first limit a batch hits, at 24 items. 16 leaves about 30% headroom;
/// `tests/create_escrow.rs::max_create_batch_fits_mainnet_limits` re-measures
/// it on every `cargo test`. See docs/adr/0012.
pub const MAX_BATCH_SIZE: u32 = 16;

/// Maximum number of operations accepted by one `settle_many` call (issue
/// #29). Measured, not guessed: every settled op emits a full escrow state
/// event plus the token's transfer event, and the per-transaction
/// contract-events-plus-return-value budget (16,384 bytes on Mainnet) is
/// the first limit a batch hits. The bound keeps a worst-case batch under
/// that and every other Mainnet per-transaction limit with headroom;
/// `tests/settle_many.rs::max_batch_fits_mainnet_limits` re-measures it on
/// every `cargo test`. See docs/adr/0012.
pub const MAX_SETTLE_OPS: u32 = 12;

/// Maximum number of escrow records returned by one `get_escrows` call.
/// Measured against the read-only simulation budget with the full
/// `EscrowData` shape; callers should chunk larger dashboards queries.
pub const MAX_GET_ESCROWS: u32 = 24;
/// Issue #39: a `Liability(token)` entry is re-extended whenever its
/// remaining TTL falls below this many ledgers (~30 days at 5 s/ledger)…
pub const LIABILITY_TTL_THRESHOLD: u32 = 518_400;
/// …to this many ledgers (~120 days), capped at the network's maximum
/// entry TTL. See docs/threat-model.md ("Solvency monitoring").
pub const LIABILITY_TTL_EXTEND_TO: u32 = 2_073_600;

/// Storage TTL parameters (threat model T6, Phase E4), expressed in
/// ledgers assuming an approximately five-second close time.
pub const INSTANCE_TTL_THRESHOLD: u32 = 120_960;
pub const INSTANCE_EXTEND_TO: u32 = 518_400;
pub const ESCROW_TTL_THRESHOLD: u32 = 518_400;
pub const ESCROW_EXTEND_TO: u32 = 3_110_400;
pub const ESCROW_GRACE_PERIOD_LEDGERS: u32 = 518_400;
pub const MAX_NETWORK_TTL_LEDGERS: u32 = 6_312_000;
pub const SETTLED_ESCROW_TTL_THRESHOLD: u32 = 120_960;
pub const SETTLED_ESCROW_EXTEND_TO: u32 = 518_400;
