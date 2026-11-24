//! Versioned storage layout for `EscrowData` (issue #37).
//!
//! Every `DataKey::Escrow(id)` entry this build writes is a
//! [`StoredEscrow`]: an enum whose variant name is the layout version and
//! whose payload is the record in that version's field set. Soroban encodes
//! a tuple enum variant as `[Symbol("V1"), payload]`, so the version tag is
//! part of the stored value and a reader can tell layouts apart without
//! guessing from the field set.
//!
//! Migration is lazy and per entry:
//!
//! - [`EscrowContract::read_escrow`] decodes **every known version** and
//!   upgrades it in memory to the latest layout (`EscrowData`). Reads never
//!   write, so read-only calls (`get_escrow`, `get_escrows`) stay read-only
//!   and cost no rent.
//! - [`EscrowContract::write_escrow`] always writes the **latest** version,
//!   so an old entry is rewritten in the new layout on its next state change
//!   (`top_up`, `accept`, `rotate_releaser`, …). Settlement of a non-pooled
//!   escrow removes the record (docs/adr/0013), so an old entry can also
//!   finish its whole life without ever being rewritten.
//!
//! Known versions:
//!
//! | Stored form                     | Written by              | Read as               |
//! |---------------------------------|-------------------------|-----------------------|
//! | untagged map without `attester` | before issue #42 (#389) | V1, `attester: None`  |
//! | untagged map with `attester`    | issue #42 until #37     | V1                    |
//! | `StoredEscrow::V1(EscrowData)`  | current                 | V1                    |
//!
//! Entries written before this module existed are bare `EscrowData` maps,
//! in one of two field sets: builds before attestation-based release
//! (issue #42) wrote no `attester` key, later builds write the full V1
//! field set. A legacy map is told apart by whether it carries the
//! `attester` key; one without it gets `attester: None` added in memory
//! before it is decoded as V1, which is exactly how such an escrow always
//! behaved (no attestation path, releasers only). A future layout change
//! must keep accepting both untagged forms (freeze V1 as the rule below
//! says and keep this key check on the legacy branch). A map and a
//! vector are different host object types, so telling the untagged form
//! from a tagged one is a type-tag check, never a trial decode that could
//! trap on a mismatched field set.
//!
//! Adding a field (the rule, also in `ARCHITECTURE_ESSENTIALS.md`):
//!
//! 1. Never change the field set of a version a released build has written.
//!    Copy today's `EscrowData` into a frozen `EscrowDataV1` struct (same
//!    field names and types; the Rust type name is not part of the encoding)
//!    and point `StoredEscrow::V1` and the untagged-legacy branch at it.
//! 2. Add the field to `EscrowData`, append `V2(EscrowData)` to
//!    `StoredEscrow`, and bump [`ESCROW_LAYOUT_VERSION`].
//! 3. Add a `V1 => …` arm to [`StoredEscrow::upgrade`] that fills the new
//!    field with the value that reproduces the old behaviour exactly
//!    (usually `None` / `false`).
//! 4. Add a test that stores a V1 entry directly and settles it by release
//!    **and** by refund (`tests/storage_layout.rs`).
//!
//! Never remove, rename or reorder a variant; never reuse a variant name.

use crate::*;
use soroban_sdk::{symbol_short, BytesN, IntoVal, TryFromVal, Val};

/// Layout version every write produces. Bump it together with a new
/// `StoredEscrow` variant; see the module docs.
pub const ESCROW_LAYOUT_VERSION: u32 = 1;

/// The value stored under `DataKey::Escrow(id)`. Storage-only: it is not
/// part of the contract interface (`export = false`), so it does not appear
/// in the contract spec or the generated SDK bindings.
#[contracttype(export = false)]
#[derive(Clone)]
pub enum StoredEscrow {
    /// The first tagged layout: the `EscrowData` field set of the last
    /// untagged builds (split payouts, protocol fee, release time,
    /// `refund_to`, acceptance, attester).
    V1(EscrowData),
}

impl StoredEscrow {
    /// Wraps a record in the latest layout version for writing.
    pub(crate) fn latest(data: EscrowData) -> Self {
        StoredEscrow::V1(data)
    }

    /// Upgrades any known version to the latest in-memory record. Pure:
    /// no storage access, so it costs only the field moves.
    pub(crate) fn upgrade(self) -> EscrowData {
        match self {
            StoredEscrow::V1(data) => data,
        }
    }
}

impl EscrowContract {
    /// Reads `DataKey::Escrow(id)` in any known layout and returns it as the
    /// latest `EscrowData`. `None` when no record exists. An entry that is
    /// neither a known tagged version nor the untagged legacy form traps,
    /// exactly as a typed `get` of a mismatched value always has.
    pub(crate) fn read_escrow(env: &Env, escrow_id: u64) -> Option<EscrowData> {
        let raw: Val = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))?;
        Some(Self::decode_escrow(env, raw))
    }

    /// Version dispatch for one stored value (see the module docs).
    pub(crate) fn decode_escrow(env: &Env, raw: Val) -> EscrowData {
        if let Ok(mut map) = soroban_sdk::Map::<Val, Val>::try_from_val(env, &raw) {
            // Untagged legacy entry written before issue #37. Builds from
            // issue #42 on wrote the full V1 field set; earlier builds wrote
            // it without `attester`, which reads as `attester: None` (no
            // attestation path, exactly how those escrows behaved).
            let attester: Val = symbol_short!("attester").into_val(env);
            if !map.contains_key(attester) {
                map.set(attester, None::<BytesN<32>>.into_val(env));
            }
            return EscrowData::try_from_val(env, &map.to_val())
                .unwrap_or_else(|_| panic!("unreadable legacy EscrowData entry"));
        }
        StoredEscrow::try_from_val(env, &raw)
            .unwrap_or_else(|_| panic!("unknown EscrowData layout version"))
            .upgrade()
    }

    /// Writes `data` under `DataKey::Escrow(id)` in the latest layout. Every
    /// state change goes through here, which is what migrates an old entry
    /// on its next write. TTL handling stays with the callers.
    pub(crate) fn write_escrow(env: &Env, escrow_id: u64, data: &EscrowData) {
        env.storage().persistent().set(
            &DataKey::Escrow(escrow_id),
            &StoredEscrow::latest(data.clone()),
        );
    }
}
