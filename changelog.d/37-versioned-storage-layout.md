Issue #37 (Phase E5): escrow records are stored as a version-tagged
`StoredEscrowData` enum (V1 to V4). New writes always use V4, and reads
decode the exact seven-field, eight-field and twelve-field legacy maps plus
the tagged variants, migrating a record only when a successful release,
refund or other state-changing call writes it back. Unknown or malformed
layouts fail closed with `UnsupportedStorageVersion` (error 35). This adds
no upgrade function: immutable deployed instances cannot run this
migration, and a separate security-reviewed upgrade decision is still
required. Policy in `ARCHITECTURE_ESSENTIALS.md` ("Persistent storage layout
policy"). Pooled escrow bodies (issue #113) are written as V4 like every
other escrow; their `Pooled` and `Contribution` records have no legacy
layout. The `Status` read key from issue #98 is still written at creation
and settlement, and `get_status` falls back to the versioned escrow body
when a legacy record has no `Status` entry. No entry point is added or
changed; the only public-surface change is the new error variant, so the
generated SDK bindings gain `UnsupportedStorageVersion`.
