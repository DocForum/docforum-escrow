bump: patch
---
#107 follow-up: resolve the Scout static-analysis backlog. Unchecked
arithmetic in the id counters (`next_id`, `NextScheduleId`), the vesting
math, `settle` and `settle_full` now uses checked operations that return the
existing `Overflow`, `InvalidSettlementAmount`, `InvalidFee` or
`SplitAmountOverflow` errors instead of trapping. Each of those cases is
unreachable with valid state (overflow checks already aborted them in
release builds). The split-payout loop iterates the payee list directly, and
the exact `floor(x * bps / 10 000)` split moved into `split_share`. Payout
amounts are unchanged for every input. No ABI, `Error` code, event or
storage-layout change.
