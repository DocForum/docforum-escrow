Issue #320 (Phase E7): profiled the ten public entry points that had no
resource baseline — `create_escrows`, `settle_many`, `create_pooled_escrow`,
`contribute`, `claim_refund`, `cancel`, `transfer_payee`, `pause`, `unpause`
and `solvency` — in `benches/resource_profile.rs`. The batch fixtures use the
worst case the contract accepts: `MAX_BATCH_SIZE` items and `MAX_SETTLE_OPS`
releases with the maximum protocol fee, an opted-in payee callback and the
64-byte `condition_ref` (plus a ten-releaser batch for the events worst case).
Numbers are in `benchmarks/baseline.json` and summarised in
`benchmarks/resource-profile.md`, including the headroom against Mainnet's
per-transaction limits. No contract or SDK surface changed, so
`CONTRACT_VERSION`, `contract-spec.json` and the generated bindings are
untouched; this is measurement only.
