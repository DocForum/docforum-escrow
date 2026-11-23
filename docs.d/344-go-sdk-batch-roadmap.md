---
file: ROADMAP.md
section: Phase E6 — SDK & integrator tooling
---
- [x] Go SDK batch create and settle (issue #344): `CreateEscrows`
  (`create_escrows`) and `SettleMany` (`settle_many`), chunked at the contract's
  measured limits — the exported `MaxBatchSize` (16) and `MaxSettleOps` (12)
  name `contracts/escrow/src/constants.rs` — with per-op results decoded in
  input order and a reverting chunk surfaced as the error alongside the chunks
  that already committed.
