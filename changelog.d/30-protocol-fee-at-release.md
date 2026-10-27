Issue #30 (Phase E5): optional protocol fee taken at release. `create_escrow`
(and `create_escrow_release_time`) accept an optional `fee_recipient`/`fee_bps`
pair, fixed at creation, capped at 10 % and floor-rounded; `release` pays that
share to `fee_recipient` and the exact remainder to the payee, while refunds
still return the full amount. `get_escrow` exposes the pair, the `ESCROW`
event snapshot appends it as one nested pair, and `top_up` re-checks the fee
math as the amount grows. Decided in `docs/adr/0010`; new invariant I7 in the
threat model; new append-only error `InvalidFee = 35`. The SDK gains
`feeRecipient`/`feeBps` on `createEscrow` (minor changeset) and regenerated
bindings. Not yet redeployed to testnet.
