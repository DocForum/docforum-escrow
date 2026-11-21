Issue #293 (Phase E5): added bounded read-only `get_escrows(ids)` and
`next_escrow_id()` views, with `None` for unknown or archived records and a
measured cap for batch reads.
