### Event payload reference (test-enforced)

Event topics and payloads for the following are pinned by golden tests in `contracts/escrow/tests/events.rs`:

- `accepted`: consumed by the indexer and SDK event decoder.
- `top_up`: consumed by the indexer and SDK event decoder.
- `rotate`: consumed by the indexer and SDK event decoder.
- `pay_xfer`: consumed by the indexer and SDK event decoder.
- `contrib`: consumed by the indexer and SDK event decoder.
- `claimed`: consumed by the indexer and SDK event decoder.
- `PayeeRefunded`: consumed by the indexer and SDK event decoder.
- `Paused` / `Unpaused`: consumed by the indexer and SDK event decoder.

Any change to these topics or payloads must update the corresponding golden test and be reviewed alongside the decoder changes.

## Test snapshot hygiene

Soroban writes one JSON snapshot per test under `contracts/escrow/test_snapshots/`. CI fails if a snapshot exists without a matching test (orphaned snapshot). When a test is renamed or removed, delete its snapshot file in the same change.

The orphaned snapshots removed by this change were:

- `refund_on_settled_escrow_emits_no_event.1.json`
- `refund_unknown_escrow_emits_no_event.1.json`
- `release_unknown_escrow_emits_no_event.1.json`
- `release_with_approvals_emits_released_event.1.json`
- `timeout_refund_after_deadline_emits_refunded_event.1.json`
