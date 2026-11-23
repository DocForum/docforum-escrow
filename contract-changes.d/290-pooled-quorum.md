bump: minor
---
Issue #290: added `create_pooled_quorum_escrow(creator, payee, token, funding_target, condition_ref, releasers, threshold, funding_deadline)`, a pooled escrow variant whose existing approval-based release paths require an M-of-N releaser set. It reuses `create_pooled_escrow`'s funding, allowlist, pause and deadline gates, stores the caller-supplied threshold, and rejects approval/rotation paths that do not match the stored set. No new entry-point errors or storage keys beyond the existing releaser set and threshold fields.
