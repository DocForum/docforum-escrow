Issue #47 (Phase E5): added opt-in on-chain idempotency for `(payer,
condition_ref)` through `create_escrow_with_uniqueness`. Duplicate retries
return `DuplicateConditionRef`; callers recover the original id with
`get_unique_escrow`. Existing creation behavior is unchanged when disabled.
