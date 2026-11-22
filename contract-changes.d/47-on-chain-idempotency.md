bump: major
---
Issue #47: added `create_escrow_with_uniqueness`, `get_unique_escrow`, and
`DuplicateConditionRef` for opt-in `(payer, condition_ref)` idempotency. The
existing `create_escrow` entry point remains unchanged; uniqueness indexes are
retained through settlement and follow the escrow persistent-storage TTL.


The interface snapshot also canonicalizes the existing `get_escrows` argument list by removing a trailing comma; its runtime ABI is unchanged. The interface gate currently classifies that snapshot normalization as a breaking change.
