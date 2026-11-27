---
"@docforum/escrow-sdk": minor
---

Add `EscrowClient.getPooledPhase(escrowId)` and the pure `pooledPhase(escrow, pooled, ledgerTime)` helper (issue #331) returning `{ phase, remaining, deadline }` (`"open" | "funded" | "failed" | "released"`) using the contract's `>=` deadline boundary and the latest ledger close time.
