---
"@docforum/escrow-sdk": minor
---

Add `checkSolvency({ contractId, tokens })` (issue #78), returning balance vs liabilities per token from the on-chain `solvency` view, with an events-based fallback for deployments that predate it, and a `check-solvency` CLI command that exits non-zero on a shortfall.

Additive only. No contract change.
