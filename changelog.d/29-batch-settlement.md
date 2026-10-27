Issue #29 (Phase E5): batch release and refund. `settle_many` now takes
`ops: Vec<(escrow_id, SettleAction)>` (`Release` | `Refund`) instead of
release-only `escrow_ids`, and `caller` authorizes the batch once (the
old version called `release` per id, so any batch of two or more failed
`Error(Auth, ExistingValue)`). Each op runs exactly the checks of
`release`/`refund` against that escrow's own releaser set, shared through
`release_checks`/`refund_checks` so the paths can't diverge. Best-effort,
decided in `docs/adr/0012`: one result per op in input order, `Err` means
untouched, the same escrow twice gives `NotFunded` on the second op, and
a failure after an op's transfer (a failing payee callback) reverts the
whole batch. Bound `MAX_SETTLE_OPS` = 20, measured: 656 bytes of events
per release against the 16,384-byte events budget (13,120 at 20).
Existing error codes unchanged (`BatchTooLarge` = 25 reused). T1
response guidance in `docs/threat-model.md`. 13 tests in
`tests/settle_many.rs`. Bindings regenerated (SDK patch). Not yet
deployed to testnet.
