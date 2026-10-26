# ADR 0008: Versioned escrow storage records

**Status:** Accepted for issue #37
**Date:** 2026-10-16

## Context

Soroban `#[contracttype]` named structs are persisted as `ScVal::Map`
values keyed by field-name symbols. Before ADR 0004, `EscrowData` had
seven fields. The next pre-version layout had those fields plus `refund_after`, for
eight. The next unversioned layout had twelve fields, including releaser
sets, quorum threshold, callback opt-in and payee-acceptance state.
`refund_to` (ADR 0009) and `release_not_before` bring the current,
still-unversioned layout to fourteen fields. A newer reader asking Soroban
to decode one shape as the other fails because the map's key set must
match the struct schema. Guessing defaults for arbitrary missing fields
would hide corrupt or unsupported records.

The contract currently has no upgrade function and deployed WASM is
immutable. No upgrade ADR has been accepted. This ADR therefore defines a
storage format and reader policy for code that may eventually run after a
separately approved upgrade; it does not authorize or implement upgrades.

## Decision

New persistent records use `StoredEscrowData`, a tagged contract enum with
version-specific structs. New writes use `V4(EscrowDataV4)`, the complete
fourteen-field current record including `refund_to` and
`release_not_before`. V1, V2, and V3 remain readable as exact historical
layouts. Future layout changes must add a new versioned struct and enum
variant rather than changing an existing version's fields.

For compatibility, the reader attempts the exact historical schemas:

1. The seven-field bare map from before ADR 0004; `refund_after` becomes
   `None` because that field did not exist in that schema.
2. The eight-field bare map used before releaser sets.
3. The exact twelve-field unversioned map that predates `refund_to` and
   `release_not_before`.
4. The exact fourteen-field unversioned current map.
5. Known version-tagged V1, V2, V3, and V4 enum variants.

Every other value fails closed with `UnsupportedStorageVersion`. Read-only
calls do not write or extend an entry. The next successful state-changing
operation writes the latest tagged V4 record, so release/refund migrate a
legacy record atomically with settlement. Pooled escrows (issue #113,
ADR 0011) store their `EscrowData` body the same way — there is no older
pooled layout to migrate from, since `create_pooled_escrow` only ever
existed alongside this scheme. Their `Pooled` and `Contribution` records
are separate storage keys and are not part of `StoredEscrowData`.

A status-only read key, `DataKey::Status` (issue #98), is written
alongside the versioned body at creation and at every settlement.
`get_status` reads it directly when present and falls back to decoding
the full versioned body — migrating it under the same rules above — for
any record written before that key existed.

## Consequences and limits

- An immutable deployed instance cannot execute this reader or migration.
  Supporting its existing data requires a separately authorized upgrade
  path; otherwise a new deployment has separate storage and does not
  migrate funds or records automatically.
- Any future upgrade ADR must specify upgrade authorization, compatibility
  guarantees, rollback/recovery, and validation against archived entries.
- The runtime/resource cost of the extra layout dispatch is unmeasured.
  This change does not claim an upgrade is safe or economical.
