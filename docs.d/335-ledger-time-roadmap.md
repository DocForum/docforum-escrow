---
file: ROADMAP.md
section: Phase E6 — SDK & integrator tooling
---
- [x] Ledger-time helper (issue #335): `client.getLedgerTime()` reads the
  latest ledger's close time (cached for a few seconds, always fresh with
  `{ maxAgeMs: 0 }`) and `client.ledgerClockOffset()` returns ledger time minus
  local time in milliseconds, ready for `useEscrowTimeline`'s
  `ledgerTimeOffsetMs`. Additive SDK surface, no contract change.
