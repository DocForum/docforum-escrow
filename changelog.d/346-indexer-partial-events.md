Issue #346 (Phase E6): the indexer now applies `pay_xfer`, `rotate`, `top_up`,
`accepted`, `contrib` and `claimed`, so an indexed escrow's `payee`,
`releasers`, `amount` and `acceptedAt` no longer go stale between lifecycle
snapshots. Each handler updates only its own field and appends an `EscrowEvent`;
a ledger comparison stops an older event from overwriting a newer snapshot, and
events for escrows created before the start ledger are skipped. The indexer
also reads the event ledger from SubQuery's resolved block (`ledger.sequence`),
which the previous `BigInt(event.ledger)` could not. Mapping unit tests use
in-memory entity fakes.
