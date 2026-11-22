bump: minor
---
Issue #47: added `create_escrow_with_uniqueness`, `get_unique_escrow`, and
`DuplicateConditionRef` for opt-in `(payer, condition_ref)` idempotency. The
existing `create_escrow` entry point remains unchanged; uniqueness indexes are
retained through settlement and follow the escrow persistent-storage TTL.
