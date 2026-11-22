---
file: ROADMAP.md
section: Phase E6 — SDK & integrator tooling
---
- [x] **Multiple RPC providers with health checks and failover (issue #123).**
  The TypeScript SDK accepts prioritized Soroban endpoints, filters providers by
  latest-ledger freshness and configured network passphrase, and retries
  idempotent reads across healthy providers. Writes remain single-provider and
  must verify a submitted transaction hash before any caller-controlled retry.
