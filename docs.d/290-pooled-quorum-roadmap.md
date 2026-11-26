---
file: ROADMAP.md
section: Phase E5 — Contract features
---
- [x] Pooled escrows settled by an M-of-N releaser set (issue #290): `create_pooled_quorum_escrow(...)` stores the supplied releasers/threshold and reuses pooled funding, allowlist and pause gates; approval-based release and settlement require full funding and the stored threshold. Covered by pooled, quorum and pause tests; bindings regenerated. Not deployed on testnet yet.
