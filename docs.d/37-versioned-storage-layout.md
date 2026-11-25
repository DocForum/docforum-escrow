---
file: ARCHITECTURE_ESSENTIALS.md
section: Storage TTL & Archival (issue #10, threat model T6)
---
### Versioned `EscrowData` layout (issue #37)

Every `DataKey::Escrow(id)` entry is stored as `StoredEscrow::V<n>(…)`
(`contracts/escrow/src/layout.rs`), so the layout version is part of the
stored value. All reads go through `read_escrow`, which accepts every known
version — plus the untagged `EscrowData` map written before issue #37, read
as V1 — and upgrades it in memory; it never writes, so read-only calls stay
read-only. Untagged maps come in two field sets: builds from issue #42
(attestation-based release) on wrote the full V1 set, earlier builds wrote it
without `attester`. The dispatch tells them apart by the `attester` key and
reads the older form with `attester: None` added in memory, which is how
those escrows always behaved. All writes go through `write_escrow`, which stores the latest
version (`ESCROW_LAYOUT_VERSION`), so an old entry is rewritten on its next
state change (`top_up`, `accept`, `rotate_releaser`, …). A settled non-pooled
escrow's record is removed (ADR 0013), so an old entry may also settle without
ever being rewritten. `StoredEscrow` is `export = false`: it is not part of the
contract spec or the SDK.

**Rule for adding (or removing, or retyping) an `EscrowData` field:**

1. Never change the field set of a version a released build has written.
   Freeze the current layout first: copy `EscrowData` into `EscrowDataV<n>`
   with identical field names and types (the Rust type name is not part of
   the encoding) and point `StoredEscrow::V<n>` — and, for V1, the
   untagged-legacy branch — at the frozen struct.
2. Change `EscrowData`, append `V<n+1>(EscrowData)` to `StoredEscrow`, and
   bump `ESCROW_LAYOUT_VERSION`.
3. Add a `V<n>` arm to `StoredEscrow::upgrade` that fills the new field with
   the value that reproduces the old behaviour exactly (usually `None` or
   `false`), so an upgraded entry settles exactly as it would have before.
4. Add a test in `contracts/escrow/tests/storage_layout.rs` that stores a
   `V<n>` entry directly and settles it by release **and** by refund.

Never remove, rename or reorder a `StoredEscrow` variant, and never reuse a
variant name. New per-escrow data that only some escrows need can still go
in its own appended `DataKey` instead (as pooled and vesting data do).

This sits under ADR 0005, not against it: the deployed WASM stays immutable
and a behaviour change still ships as a new contract id, so within one
deployment every entry is written by the same code. The version tag makes the
stored data self-describing, keeps an old layout readable if a future,
separately reviewed ADR ever adds an upgrade path, and turns "migration" into
a lazy per-entry rewrite under each escrow's own calls rather than the bulk
on-chain migration hook ADR 0005 rejects. Measured cost (local Soroban host,
release WASM, issue #37 PR): reading a tagged V1 entry costs about 8.0k more
CPU instructions than reading an untagged one (≈ 0.9 % of `get_escrow`), and
with the 955-byte larger WASM every call costs ≈ 1.4–3.9 % more CPU than on
`main`; memory moves by under 0.5 %. `tests/storage_layout.rs` guards the
dispatch on the native host.
