---
file: ROADMAP.md
section: Phase E6 — SDK & integrator tooling
---
- [x] SDK pooled release deadline and `closeFailedRound` (issue #470):
  `createPooledEscrow({ releaseDeadline })`, `getPooled().releaseDeadline` and
  `closeFailedRound` in the TypeScript SDK, and `PooledData.ReleaseDeadline` in
  the Go SDK. Omitting `releaseDeadline` sends the same `create_pooled_escrow`
  call as before.
