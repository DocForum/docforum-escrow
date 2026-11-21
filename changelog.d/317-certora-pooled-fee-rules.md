Issue #317 (Phase E7): extended the formal-verification spike with the
pooled-escrow accounting rules (I4, ADR 0011) and fee-conservation rules
(I7, ADR 0010). `certora/escrow.spec` now states exact-balance inbound
transfers, contribution recording only after verification, the
`amount == Σ unclaimed contributions` aggregate, `claim_refund` paying the
recorded amount exactly once, a pooled `release` requiring
`amount == funding_target`, fee + payout summing to the stored amount on
release, the fee being charged on the split payee share, and refund/cancel
paths never paying `fee_recipient`. `docs/formal-verification.md` records the
new scope, the error discriminants relied on, and the honest status: still
specified, not machine-checked — no Certora run is attached. No contract or
SDK surface changed, so there is no contract-changes fragment, bindings
regeneration or version bump.
