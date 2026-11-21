---
file: ROADMAP.md
section: Phase E6 — SDK & integrator tooling
---
- [x] Solvency checker (issue #78): `checkSolvency({ contractId, tokens })` returns balance vs liabilities per token from the on-chain `solvency` view, with an events-based fallback for deployments that predate it, and a `check-solvency` CLI command that exits 1 on a shortfall. Read-only, no secret needed.
