---
file: ROADMAP.md
section: Phase E6 — SDK & integrator tooling
---
- [x] Python SDK quorum support (issue #472): `create_escrow_with_releasers`,
  `release_with_approvals` and `refund_with_approvals`, with client-side
  `check_releaser_set` validation and fail-closed Soroban auth-entry signing
  for the supplied approver keypairs. Package 0.3.0; no contract change.
