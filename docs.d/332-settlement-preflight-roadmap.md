---
file: ROADMAP.md
section: Phase E6 — SDK & integrator tooling
---
- [x] Settlement preflight (issue #332): `canRelease`/`canRefund` return
  `{ ok, reasons }` from the escrow, pooled config, caller and ledger clock
  without signing, in the contract's check order so `reasons[0]` is the error it
  would return; `release`/`refund` can refuse a doomed call before simulating
  (`checkPreconditions: true`). Additive SDK surface, no contract change.
