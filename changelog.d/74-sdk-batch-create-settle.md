Issue #74 (Phase E5): added batched escrow creation and settlement. The
contract gains `create_escrows(payer, items)` (atomic, `items.len()` <=
`MAX_BATCH_SIZE` = 50) and `settle_many(caller, escrow_ids)` (per-op
`Result` in input order), and the `BatchTooLarge` error is appended at
discriminant 25 so every existing `Error` value keeps its on-chain number.

The SDK gains `createEscrows(items)` / `settleMany(ops)`: they chunk to
`MAX_BATCH_SIZE`, map results back to the caller's input order, throw a
`BatchPartialFailureError` carrying every per-item result when anything
fails, and accept `{ resumeFrom }` so a retry only sends what failed. The
batching is implemented in the wrapper by looping over the existing
singular `create_escrow` / `release` / `refund` calls, so no per-batch auth
or state semantics are introduced on the client. `sdk/src/generated/`
was regenerated with the pinned Stellar CLI 28.1.0.
