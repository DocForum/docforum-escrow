---
file: docs/threat-model.md
after: '| T19 — Contributor-resource exhaustion / unbounded refund loops | `tests/pooled.rs::no_contributor_cap_each_claim_is_independent` (bounded per-claim work, no cap by design) | Covered (design) |'
---
| T295 — Fee recipient cannot receive at release | `tests/undeliverable.rs::unauthorized_sac_fee_recipient_blocks_release_atomically_and_can_be_retried` | Covered: the fee-first transfer fails atomically with `Undeliverable`; the escrow remains funded for retry |
