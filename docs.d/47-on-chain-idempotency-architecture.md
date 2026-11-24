---
file: ARCHITECTURE_ESSENTIALS.md
section: Contract surface
---
create_escrow_with_uniqueness(..., fee_recipient, fee_bps, unique_ref) -> escrow_id // IMPLEMENTED (issue #47) — optional persistent `(payer, condition_ref)` index; duplicate attempts return `DuplicateConditionRef`, and `get_unique_escrow` recovers the original id; legacy creation remains unchanged
