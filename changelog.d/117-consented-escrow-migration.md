Issue #117 adds a consented migration bridge for funded, non-pooled escrows.
The receiving deployment allowlists source contract addresses at construction;
the stored payer and sole releaser authorize `export_to`, and the source record
is marked `Migrated` only after the target imports the record and receives the
exact token balance. Existing testnet deployments predate the entry points and
must continue to be settled in place.
