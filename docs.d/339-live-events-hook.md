---
file: ROADMAP.md
section: Phase E6 — SDK & integrator tooling
---
- [x] `escrow-react` live events (issue #339): `useEscrowEvents({ escrowId?,
  types?, cursor? })` wraps `client.subscribe` with lifecycle management
  (including StrictMode), keeps a bounded event list, exposes the latest
  cursor, invalidates matching escrow queries, and reports an expired cursor
  as state instead of throwing.
