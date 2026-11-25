---
file: ROADMAP.md
section: Phase E6 — SDK & integrator tooling
---
- [x] Python SDK single-party amendments (issue #471): `create_escrow_with_acceptance`,
  `accept`, `cancel`, `top_up` and `transfer_payee` in `sdk-python` 0.2.0. The
  signer is the acting party, and a mismatched actor is rejected before any
  request. Arguments are checked against `contract-spec.json`.
