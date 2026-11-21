---
file: ROADMAP.md
section: Phase E5 — Contract features
---
- [x] Quorum releaser rotation (issue #294, ADR 0009): `rotate_releaser_with_approvals(escrow_id, approvers, old, new)` replaces one member of an M-of-N set with `threshold` approvals plus the payer's consent; the outgoing member's approval counts. Tests: `contracts/escrow/tests/releaser_rotation.rs`.
