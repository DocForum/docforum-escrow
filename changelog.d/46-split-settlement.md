Issue #46 (Phase E5): added `settle(escrow_id, caller, payee_amount)`. A single
releaser pays `payee_amount` (0 to the full amount) to the payee and the rest to the
escrow's `refund_to`. Quorum escrows must use the approval path. The split applies the
same release-time and payee-acceptance gates as `release`, and pooled escrows are rejected
(`NotSupportedForPooled`). Out-of-range amounts return the new `InvalidSettlementAmount` (35).
Contract bindings regenerated; the TLA+ spec under `spec/` does not model `settle` yet.
