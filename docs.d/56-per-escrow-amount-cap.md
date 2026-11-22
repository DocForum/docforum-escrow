---
file: ROADMAP.md
section: Phase E5 — Contract features
---
- [x] Per-escrow maximum amount cap (issue #56, ADR 0016): the constructor
  fixes optional per-token caps for a guarded staged mainnet beta; all deposit
  paths enforce the complete escrow amount before token movement. Raising a
  cap requires a new deployment.
