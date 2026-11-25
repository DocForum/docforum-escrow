---
file: ROADMAP.md
section: Phase E6 — SDK & integrator tooling
---
- [x] Go SDK contract-state reads and version guard (issue #342): `Version`,
  `IsPaused`, `GetPauseAdmin` and `Solvency` reads, plus the optional
  `Config.ContractVersionCheck` (off by default) that checks `version()` once
  before the first write against the same `>=2.0.0 <4.0.0` range as the
  TypeScript SDK's `SUPPORTED_CONTRACT_VERSIONS`. A deployment without
  `version()` is a typed `*VersionUnavailableError`, not a generic simulation
  failure. Offline fake-RPC tests; documented in `sdk-go/README.md`.
