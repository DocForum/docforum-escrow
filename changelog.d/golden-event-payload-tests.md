### Tests

- Added golden tests in `contracts/escrow/tests/events.rs` asserting the exact topic and payload for every non-lifecycle event: `accepted`, `top_up`, `rotate`, `pay_xfer`, `contrib`, `claimed`, `PayeeRefunded`, `Paused`, and `Unpaused`. Indexers and SDK decoders can now rely on these shapes being changed only by a deliberate, reviewed diff.
- Removed orphaned Soroban test snapshots (`refund_on_settled_escrow_emits_no_event`, `refund_unknown_escrow_emits_no_event`, `release_unknown_escrow_emits_no_event`, `release_with_approvals_emits_released_event`, `timeout_refund_after_deadline_emits_refunded_event`) under `contracts/escrow/test_snapshots/` that no longer correspond to any test, so the "Fail if test snapshots are orphaned" CI step passes.
