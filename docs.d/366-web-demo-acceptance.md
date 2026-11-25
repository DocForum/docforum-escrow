---
file: ROADMAP.md
section: Phase E6 — SDK & integrator tooling
---
- [x] Browser demo payee acceptance and payer cancel (issue #366):
  `examples/web-demo/` gains a creation form with a `requiresAcceptance`
  toggle, a payee review panel listing every `getEscrow` field T8 says to
  check (releasers/threshold, `refundAfter`, `refundTo`) plus the fee, and
  Accept/Cancel actions enabled only while the contract would allow them.
