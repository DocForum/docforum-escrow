# Audit delta: split payee payouts

- **Code commit:** 1325f1a (the implementation merge commit; this document follows it).
- **Frozen review baseline:** 797c1170516847b64ef2b10df3d2abd517248284.
- **Diff scope:** the baseline-to-current-main changes included by merging 9d81349, plus this PR's changes to the escrow contract, tests, generated SDK bindings, and security documentation. The full diff should be reviewed against the frozen baseline; this note describes the incremental split-payout risks.
- **Review status:** delta review requested; no independent security review is claimed.

## Changed behavior

create_split_escrow stores up to eight unique payees with positive basis-point shares totaling 10,000. The set is immutable after creation. On release, the existing protocol fee is paid first, the fee-free net is divided using checked arithmetic, and the final payee receives the rounding remainder. Refunds still go only to stored refund_to. Existing settlement authorization, status-before-transfer ordering, and transaction rollback behavior remain in force.

## Incremental threats and controls

- A malformed, duplicate, excessive, or incomplete share list is rejected before authorization or token transfers.
- Arithmetic uses quotient/remainder decomposition and checked operations; tests cover exact sums, rounding dust, fee-first distribution, duplicate shares, invalid totals, and the eight-recipient limit.
- Each additional transfer increases execution cost and introduces another possible token failure. The maximum of eight bounds this work, and Soroban transaction rollback must keep the entire release atomic if any transfer fails.
- Indexers reading get_escrow can inspect the stored shares. The existing summary event retains the primary payee; consumers that need the full list must read the escrow record.

## Validation

The Rust escrow test suite, split-payout tests, release WASM build, generated-binding check, and resource-baseline check pass locally. The TLA+ payout-destination invariant was updated, but TLC could not be run in this environment because Java is unavailable.
