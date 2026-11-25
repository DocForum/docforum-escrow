---
file: ROADMAP.md
section: Phase E6 — SDK & integrator tooling
---
- [x] `waitForStatus` settlement-confirmation helper (issue #368): polls
  `get_status` until an escrow reaches one of the target statuses, bounded by
  a deadline and poll interval and cancellable with an `AbortSignal`. Rejects
  with a typed `WaitTimeoutError` carrying the last status seen, and
  short-circuits when the escrow settles on a terminal status outside the
  target set. SDK only; no contract change.
