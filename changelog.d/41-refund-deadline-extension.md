Issue #41 (Phase E5): mutually consented refund deadline extension, ADR 0004.
`extend_refund_after(escrow_id, new_deadline)` moves a `Funded`,
single-releaser escrow's `refund_after` later, requiring both the payer's
and the releaser's authorization. Rejects a missing deadline, a deadline
that has already passed, or a proposed deadline that is not strictly later.
Emits `refund_deadline_extended`. New error `InvalidRefundExtension` (code
35, appended after the pooled-escrow variants so their discriminants keep
their on-chain values). SDK `client.extendRefundAfter()` accepts any
`EscrowSigner` for both parties; bindings regenerated. Not yet on testnet.
