---
file: ROADMAP.md
section: Phase E6 — SDK & integrator tooling
---
- [x] `escrow-react` lifecycle actions (issue #337): `useEscrowActions` gained
  `accept`, `cancel` and `topUp(escrowId, amount)`, each invalidating
  `escrowKeys.detail`, resolving wallet rejection as
  `{ status: "rejected" }`, and surfacing `EscrowPreconditionError` as a typed
  `{ status: "precondition", error }` result.
