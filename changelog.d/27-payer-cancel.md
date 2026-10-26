Issue #27 (Phase E5): payer `cancel` before the payee accepts, ADR 0010.
`cancel(escrow_id, payer)` works only while `Funded`, on an escrow created with
the acceptance gate, and before `accept`; funds go to the stored `refund_to`.
New terminal `EscrowStatus::Cancelled`, no new error codes. SDK
`client.cancel()`, bindings regenerated, `@docforum/escrow-sdk` 0.6.0 → 0.7.0.
Not yet on testnet.
