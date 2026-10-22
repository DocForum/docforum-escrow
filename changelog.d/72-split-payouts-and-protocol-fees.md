Issue #72 (Phase E6): split payouts and an optional protocol fee, on-chain.

A new contract entry point, `create_escrow_with_splits`, divides the released
amount between up to 10 recipients in basis points summing to exactly 10,000,
with an optional fee in basis points taken off the top. The rounding
remainder goes to the last recipient, so `fee + shares` always equals the
escrowed amount and nothing is ever stranded in the contract. Refunds ignore
both and still return the full amount to `refund_to`.

`create_escrow`, `create_escrow_release_time`, `create_escrow_with_acceptance`
and `create_escrow_with_releasers` keep their signatures and behaviour — the
separate entry point exists so deployed clients (including `sdk-go`, which
encodes arguments positionally) do not break. Splits are single-releaser only
for now.

New read-only `preview_payout(escrow_id)` returns the exact fee and
per-recipient amounts using the settlement's own math. The SDK gains
`createEscrow({ splits, fee })`, `previewPayout(escrowId)`, an offline
`computePayout()` and client-side `validateSplits`/`validateFee`; `Escrow`
and `getEscrow` expose the stored configuration. New errors are appended as
`InvalidSplits = 26`, `TooManyRecipients = 27`, `InvalidFee = 28` — no
existing discriminant moved. Bindings regenerated with the pinned CLI
28.1.0. Design and trade-offs: `docs/adr/0011`.
