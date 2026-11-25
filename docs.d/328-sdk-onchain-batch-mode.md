Target: `README.md` (Batch helpers / SDK)

- `createEscrows(items, { mode: "onchain" })` / `settleMany(ops, { mode: "onchain" })`: submits chunks through the contract's `create_escrows` (up to `MAX_BATCH_SIZE = 16`) and `settle_many` (up to `MAX_SETTLE_OPS = 12`) entry points, grouping by signer/caller and mapping per-op results back to input order. Default mode remains `"sequential"`.
