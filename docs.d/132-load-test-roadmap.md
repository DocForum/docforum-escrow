---
file: ROADMAP.md
section: Phase E7 — Verification, testing & release engineering
---
- [ ] **Local-network high-volume load test** (issue #132) — `scripts/load/`
  creates and settles thousands of escrows on a throwaway local Stellar
  network through a pool of channel accounts (each also the releaser of its
  own escrows), recording throughput, latency percentiles and classified
  failures, then re-reads every escrow and fails unless each is in its
  expected terminal state. The SDK exports the reusable
  `ChannelAccountPool`, and `.github/workflows/load-test.yml` runs the
  harness manually against Stellar Quickstart and publishes the report.
  `docs/performance.md` documents methodology, known bottlenecks and
  recommendations. A reference run's numbers are still to be recorded: the
  authoring environment had no Docker daemon, so no local network could be
  booted. The harness refuses any non-loopback RPC URL.
