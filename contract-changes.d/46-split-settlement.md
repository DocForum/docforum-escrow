bump: minor
---
Issue #46: releaser-authorized split settlement. New `settle(escrow_id, caller, payee_amount)` pays a chosen gross amount to the payee and returns the rest to `refund_to`, under the same release-time and acceptance gates as `release`. A protocol fee applies to the payee share only, never to the refunded part (ADR 0010), so `settle(0)` matches `refund` and `settle(amount)` matches `release`. Streamed and multi-payee escrows are rejected with `SettlementNotSupported`. New errors `InvalidSettlementAmount` (4600) and `SettlementNotSupported` (4601), both provisional.
