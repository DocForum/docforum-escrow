bump: minor
---
Issue #35 (Phase E5): deposit-only emergency pause (ADR 0011). The
constructor gains a second argument (`pause_admin`) and the contract gains
`pause`/`unpause`/`is_paused`/`get_pause_admin` entry points plus the
`Paused`/`Unpaused` events and the `Paused`, `AlreadyPaused`, `NotPaused`
errors (provisional codes 3500–3502, renumbered by the maintainer fold).
Every deposit path is gated — `create_escrow` and its variants, `top_up`,
and pooled `create_pooled_escrow`/`contribute` — while `release`, `refund`,
the timeout refund, pooled `claim_refund` and both `settle_many` ops never
read the flag, so a pause can never lock funds already escrowed.
