Issue #308 (Phase E7): added a second cargo-fuzz target,
`contracts/escrow/fuzz/fuzz_targets/settlement.rs`, for quorum settlement
and `settle_many`. It creates escrows with arbitrary releaser sets and
thresholds, then drives `release_with_approvals` / `refund_with_approvals`
with arbitrary approver lists (duplicates, non-members, short lists) and
`settle_many` with arbitrary op vectors (repeats, unknown ids, lengths past
`MAX_SETTLE_OPS`). After every step it asserts fund conservation, at most
one payout per escrow, and that a rejected call or op leaves its escrow
untouched; each call's outcome is also checked against a model of the
ADR 0007 / ADR 0012 rules. Seed corpus in `fuzz/corpus/settlement/`. The
`contract-fuzz` CI job now builds and runs both targets, splitting the old
budget (15 s each on PRs, 300 s each nightly). No contract or SDK change.
