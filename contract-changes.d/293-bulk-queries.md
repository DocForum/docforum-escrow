bump: minor
---
Issue #293: add the read-only `get_escrows(ids)` batch getter and
`next_escrow_id()` counter view. The batch is capped at `MAX_GET_ESCROWS` and
does not change settlement behavior.
