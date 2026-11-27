---
file: ROADMAP.md
section: Phase E7 — Verification, testing & release engineering
---
- [x] **Worst-case resource profiles for the unbenchmarked entry points
  (issue #320)** — `create_escrows`, `settle_many`, `create_pooled_escrow`,
  `contribute`, `claim_refund`, `cancel`, `transfer_payee`, `pause`,
  `unpause` and `solvency` now have measurements in
  `benchmarks/baseline.json`, so every public entry point is covered. The
  batch fixtures use `MAX_BATCH_SIZE`/`MAX_SETTLE_OPS` with the maximum
  protocol fee, an opted-in payee callback, ten releasers and the 64-byte
  `condition_ref`; `benchmarks/resource-profile.md` records the measured
  events and instruction headroom against Mainnet's per-transaction limits.
  No contract or SDK behaviour changed.
