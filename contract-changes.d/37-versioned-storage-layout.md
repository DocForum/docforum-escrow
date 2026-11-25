bump: minor
---
Issue #37: versioned storage layout for `EscrowData`. `DataKey::Escrow(id)`
values are now written as the storage-only enum `StoredEscrow::V1(EscrowData)`
(`[Symbol("V1"), map]` on the ledger) instead of a bare `EscrowData` map.
Every read goes through one dispatch that accepts each known version and the
pre-#37 untagged map (both the field set with `attester` and the older one
without it, read as `attester: None`), upgrades in memory, and never writes; every write
stores the latest version, so an old entry migrates on its next state
change. No entry point, argument, event or error changed, and the contract
spec is identical (`StoredEscrow` is `export = false`); the raw ledger
encoding of new escrow entries did change, so the committed test snapshots
were refreshed.
