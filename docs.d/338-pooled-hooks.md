---
file: ROADMAP.md
section: Phase E6 — SDK & integrator tooling
---
- [x] `escrow-react` pooled hooks (issue #338): `usePooledEscrow(id)` reads
  `getEscrow` + `getPooled` and derives an `open` / `funded` / `failed` /
  `released` phase from the contract's boundary rules, polling until the phase
  is settled (a failed round stays `Funded` on-chain). `useContribution(id,
  address)` reads one contributor's record, and `contribute` / `claimRefund`
  were added to `useEscrowActions` with invalidation of both queries.
