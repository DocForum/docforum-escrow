---
file: README.md
section: Contract surface
---
For retry-safe funding, `create_escrow_with_uniqueness` optionally indexes
`(payer, condition_ref)` on chain. A duplicate returns
`DuplicateConditionRef`; call `get_unique_escrow(payer, condition_ref)` to
recover the original id. The index is payer-scoped, retained through
settlement, and follows the escrow storage TTL. The legacy `create_escrow`
entry point does not enable uniqueness.
