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
