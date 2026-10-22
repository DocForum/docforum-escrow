Issue #73 (Phase E6): per-escrow disputes and split settlement. ADR 0009 adds
`create_escrow_with_arbiter`, `raise_dispute` (payer/payee/releaser, only while
`Funded`), `resolve_dispute` (arbiter only, once, basis points summing to
10_000), `settle` (permissionless, pays both sides from the recorded split) and
`get_dispute`, plus the `Disputed` status. The new error codes are appended as
25–28 so the discriminants already published on testnet (21–24) do not move.
Dispute state lives under `DataKey::Dispute`, so `EscrowData`'s encoding and the
existing committed snapshots are untouched. The arbiter entry point also
accepts `refund_to` and `release_not_before`, so adding an arbiter never costs
an escrow its sponsored refund destination or release schedule. SDK 0.5.0 →
**0.6.0**: `raiseDispute`/`resolveDispute`/`settle`, `arbiter`/`splitBps` on
`createEscrow`/`getEscrow`, the pure `availableActions` helper, offline matrix
tests, and regenerated bindings with the pinned CLI. **Not yet on testnet.**
