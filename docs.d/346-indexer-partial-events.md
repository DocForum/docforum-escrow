---
file: ROADMAP.md
section: Phase E6 — SDK & integrator tooling
---
- [x] Indexer applies non-lifecycle events (issue #346): handlers and project
  filters for `pay_xfer`, `rotate`, `top_up`, `accepted`, `contrib` and
  `claimed`, each updating only the field it carries and recorded in
  `EscrowEvent`. A ledger-based ordering guard stops an older event from
  overwriting a newer snapshot, events for escrows created before the start
  ledger are skipped, and mapping unit tests cover every handler and both
  snapshot layouts.
