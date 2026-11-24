---
file: ROADMAP.md
section: Phase E5 — Contract features
---
- [x] **Versioned storage layout and a migration strategy for `EscrowData`
  (issue #37)** — escrow records are stored as `StoredEscrow::V<n>` with an
  explicit version tag; readers accept every known layout (including the
  pre-#37 untagged map) and upgrade in memory, and the next state change
  writes the latest version. Tests store old-layout entries directly and
  settle them by release and refund. The rule for adding fields is in
  `ARCHITECTURE_ESSENTIALS.md`; ADR 0005 (immutable, redeploy) is unchanged.
