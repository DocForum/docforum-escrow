---
file: ROADMAP.md
section: Phase E6 — SDK & integrator tooling
---
- [x] Go SDK pooled escrows (issue #341): `CreatePooledEscrow`, `Contribute`,
  `ClaimRefund`, `GetPooled` and `GetContribution` with `PooledData` /
  `Contribution` decoders, contract codes 26–34 named, and
  `Option<Contribution>` modelled as `*Contribution` so “never contributed”
  stays distinct from `NotFound` / `NotPooled`. Offline decoder tests, and an
  opt-in failed round with two contributors and two claims.
