---
"@docforum/escrow-sdk": minor
---

Add `mode: "onchain"` to `BatchOptions` (issue #328) so `createEscrows` and `settleMany` can submit chunks through the contract's `create_escrows` (max 16) and `settle_many` (max `MAX_SETTLE_OPS = 12`) entry points, grouping by signer/caller and mapping per-op results back to input order. Default remains `"sequential"`. A failing opted-in payee callback reverts a whole `settle_many` call, so `settleMany` retries a reverted chunk one transaction per op, keeping a hostile payee from blocking other releases (issue #367, docs/adr/0012).
