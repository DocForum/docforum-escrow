Issue #37 (Phase E5): `EscrowData` now has a versioned storage layout. Every
`DataKey::Escrow(id)` entry is written as `StoredEscrow::V<n>` (an explicit
version tag, `ESCROW_LAYOUT_VERSION` = 1); readers accept every known layout,
including the untagged map that builds before this change wrote (with or
without the `attester` field added by issue #42; a map without it reads as
`attester: None`), upgrade it in memory, and write the latest version back on the next state change.
Read-only calls never rewrite an entry. `StoredEscrow` is storage-only
(`#[contracttype(export = false)]`), so the contract spec, the generated SDK
bindings and the SDK are unchanged. New tests in
`contracts/escrow/tests/storage_layout.rs` store old-layout entries directly
and settle them by release and refund. The rule for adding a field is in
`ARCHITECTURE_ESSENTIALS.md` (via `docs.d/37-versioned-storage-layout.md`).
ADR 0005 is unchanged: the contract is still immutable and a behaviour change
still ships as a new contract id.
