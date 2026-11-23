---
file: ROADMAP.md
section: Phase E6 — SDK & integrator tooling
---
- [x] Rust interface crate for cross-contract calls (issue #69):
  `crates/escrow-interface` exposes the shared lifecycle types, contract
  errors and generated `EscrowClient`; `contracts/examples/escrow-interface`
  demonstrates nested create/release calls and the caller/releaser auth rule.
