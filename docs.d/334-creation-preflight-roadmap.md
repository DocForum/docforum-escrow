---
file: ROADMAP.md
section: Phase E6 — SDK & integrator tooling
---
- [x] Creation preflight (issue #334): `createEscrow`, `createQuorumEscrow`,
  `createPooledEscrow` and `createEscrows` items reject a non-positive amount,
  a `refundTo` or `feeRecipient` equal to the contract id, and a
  `releaseNotBefore` later than `refundAfter` before simulation, naming the
  matching contract error.
