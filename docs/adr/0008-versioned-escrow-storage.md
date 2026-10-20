# ADR 0008: Versioned escrow storage records

**Status:** Accepted for issue #37
**Date:** 2026-10-16

## Context

Soroban `#[contracttype]` named structs are persisted as `ScVal::Map`
values keyed by field-name symbols. Before ADR 0004, `EscrowData` had
seven fields. The next pre-version layout had those fields plus `refund_after`, for
eight. The current unversioned layout has twelve fields, including releaser
sets, quorum threshold, callback opt-in and payee-acceptance state. A newer reader asking Soroban to decode one
shape as the other fails because the map's key set must match the struct
schema. Guessing defaults for arbitrary missing fields would hide corrupt
or unsupported records.

The contract currently has no upgrade function and deployed WASM is
immutable. No upgrade ADR has been accepted. This ADR therefore defines a
storage format and reader policy for code that may eventually run after a
separately approved upgrade; it does not authorize or implement upgrades.

## Decision

New persistent records use `StoredEscrowData`, a tagged contract enum with
version-specific structs. New writes use `V3(EscrowDataV3)`. V1 and V2 remain readable as exact historical layouts; V3 stores the complete current record. Future layout
changes must add a new versioned struct and enum variant rather than
changing an existing version's fields.

For compatibility, the reader attempts the exact historical schemas:

1. The seven-field bare map from before ADR 0004; `refund_after` becomes
   `None` because that field did not exist in that schema.
2. The eight-field bare map used before releaser sets.
3. The exact twelve-field unversioned current map.
4. Known version-tagged V1, V2, and V3 enum variants.

Every other value fails closed with `UnsupportedStorageVersion`. Read-only
calls do not write or extend an entry. The next successful state-changing
operation writes the latest tagged V3 record, so release/refund migrate a
legacy record atomically with settlement.

## Consequences and limits

- An immutable deployed instance cannot execute this reader or migration.
  Supporting its existing data requires a separately authorized upgrade
  path; otherwise a new deployment has separate storage and does not
  migrate funds or records automatically.
- Any future upgrade ADR must specify upgrade authorization, compatibility
  guarantees, rollback/recovery, and validation against archived entries.
- The runtime/resource cost of the extra layout dispatch is unmeasured.
  This change does not claim an upgrade is safe or economical.
