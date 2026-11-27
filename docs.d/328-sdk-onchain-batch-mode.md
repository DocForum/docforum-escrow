---
file: README.md
section: How it's used
---
- `createEscrows(items, { mode: "onchain" })` / `settleMany(ops, { mode: "onchain" })`: submits chunks through the contract's `create_escrows` (up to `MAX_BATCH_SIZE = 16`) and `settle_many` (up to `MAX_SETTLE_OPS = 12`) entry points, grouping by signer/caller and mapping per-op results back to input order. Default mode remains `"sequential"`. A failing opted-in payee callback reverts a whole `settle_many` call, so `settleMany` retries a reverted chunk one transaction per op, keeping a hostile payee from blocking other releases (issue #367, docs/adr/0012).
