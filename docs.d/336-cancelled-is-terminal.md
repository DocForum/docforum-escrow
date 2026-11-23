---
file: ROADMAP.md
section: Phase E6 — SDK & integrator tooling
---
- [x] `escrow-react` terminal statuses (issue #336): `Cancelled` (ADR 0010) is
  final everywhere. `isTerminalStatus` is an exhaustive switch over
  `EscrowStatus`, so `useEscrow` stops polling a cancelled escrow and
  `useEscrowTimeline` stops its countdown; React Testing Library tests cover
  both paths.
