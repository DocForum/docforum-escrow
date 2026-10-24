Issue #113 (Phase E5): pooled escrows funded by multiple payers with
pull-based pro-rata refunds, decided in `docs/adr/0011` (open
contributions until an explicit funding target vs a fixed contributor
list — open contributions chosen). New contract entry points
`create_pooled_escrow`, `contribute`, `claim_refund`, `get_pooled`,
`get_contribution`; append-only errors 26–34; `EscrowData` and every
existing entry point unchanged, so single-payer behavior is untouched
and all pre-existing test snapshots are byte-identical. `release` now
requires `funded == target` on pooled escrows; push refund/cancel/top_up
are rejected for them (`NotSupportedForPooled`); a missed funding
deadline opens per-contributor `claim_refund` (exact recorded amounts,
once each, no contributor iteration — no cap by design). Threat model
I1–I4 generalized plus new T16–T19. SDK: additive wrappers
(`createPooledEscrow`/`contribute`/`claimRefund`/`getPooled`/
`getContribution`) and regenerated bindings, `0.7.0 → 0.8.0` (minor).
Not yet deployed to testnet — the live deployment predates it.
