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
// Phase E5 (issue #48): a settled escrow's full record is removed and only
// its `Status` entry remains; the settlement event is the audit record — see
// docs/adr/0013.
// Phase E5 (issue #119): an escrow can instead be created with an M-of-N
// releaser set (`create_escrow_with_releasers`) — see docs/adr/0007.
// Single-releaser escrows are stored as a one-address set with threshold 1
// and behave exactly as before.
// Phase E5 (issue #35): a narrow emergency pause — see docs/adr/0011. One
// address set at deploy may flip a flag that blocks NEW deposits
// (`create_escrow`, `create_escrow_release_time`, `create_escrow_with_*`,
// `create_pooled_escrow`, `top_up` and `contribute`) only. `release`,
// `refund`, the timeout refund, `claim_refund` and `settle_many` never read
// it: a pause can stop new exposure, never lock existing funds.
// Phase E5 (issue #29): `settle_many(caller, ops)` settles up to
// `MAX_SETTLE_OPS` escrows (release or refund each) in one transaction,
// best-effort with per-op results — see docs/adr/0012 and threat model T1.
//
// Phase E5 (issue #30): optional protocol fee (`fee_recipient` +
// `fee_bps`, one off-the-top cut), fixed at creation and taken at
// release — see docs/adr/0010. Never taken on refund.
//
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
//
// Formal verification (issue #101): invariants I1 (funds only leave to the
// stored `payee`, or to the stored `refund_to` on refund/cancel), I2 (only
// releasers settle — `threshold` distinct ones on a quorum escrow, and payee
// acceptance when configured — or anyone after `refund_after`) and I3 (at
// most one payout) are specified in `certora/escrow.spec`. The spec names the
// entry points and `Error` discriminants below, and
// `docs/formal-verification.md` records the scope, the assumptions and the
// current status. The properties have not been machine-checked yet: do not
// describe them as proven.
#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error,
    symbol_short, token, Address, Env, IntoVal, String, Vec,
};

// Bump this value whenever a contract interface or behavior change is made.
// CI checks this constant against the base branch when this file changes.
pub const CONTRACT_VERSION: &str = "3.1.0";

include!(concat!(env!("OUT_DIR"), "/contract_metadata.rs"));

// One module per area, each with its own `#[contractimpl]` block. Keep the
// list alphabetical (rustfmt's order); adding or reordering modules reorders
// the contract spec entries, so regenerate the SDK bindings afterwards.
mod constants;
mod errors;
mod events;
mod types;

pub use constants::*;
pub use errors::*;
pub use events::*;
pub use types::*;

#[contract]
pub struct EscrowContract;

mod admin;
mod create;
mod internal;
mod pause;
mod payee_transfer;
mod pooled;
mod queries;
mod refund_extension;
mod release_refund;
mod releasers;
mod settle;
mod storage;
mod top_up;
mod vesting;
