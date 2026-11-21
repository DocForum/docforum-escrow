---
file: ROADMAP.md
section: Phase E6 — SDK & integrator tooling
---
- [x] Python client SDK (issue #68) — `sdk-python/`, package
  `docforum_escrow` on `stellar-sdk` 17. `create_escrow`, `get_status`,
  `get_escrow`, `release`, `refund`, one typed `ContractError` subclass per
  contract error code (named like the TS SDK's), `int` i128 amounts with range
  checks, offline unit tests in `.github/workflows/sdk-python.yml`, and an
  opt-in live testnet suite kept out of CI. Not on PyPI; publish plan in
  `sdk-python/README.md`.
