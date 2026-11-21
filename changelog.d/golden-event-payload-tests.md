### Tests

- Added golden tests in `contracts/escrow/tests/events.rs` asserting the exact topic and payload for every non-lifecycle event: `accepted`, `top_up`, `rotate`, `pay_xfer`, `contrib`, `claimed`, `PayeeRefunded`, `Paused`, and `Unpaused`. Indexers and SDK decoders can now rely on these shapes being changed only by a deliberate, reviewed diff.
