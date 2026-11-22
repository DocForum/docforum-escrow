---
file: ROADMAP.md
section: Phase E5 — Contract features
---
- [x] Payout-time shared-pool solvency guard (issue #38): settlement checks
  the token balance before transfer and returns `PoolInsufficient` on a
  post-creation shortfall; clawback behavior is covered by contract tests.
