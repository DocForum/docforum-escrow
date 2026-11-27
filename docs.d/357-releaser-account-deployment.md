---
file: ROADMAP.md
section: Phase E7 — Verification, testing & release engineering
---
- [x] **Deterministic releaser-account deployment** (issue #357) —
  `scripts/deploy-releaser-account` deploys the optional M-of-N custom
  releaser account (ADR 0005) from a reviewed JSON config, validates it before
  any network call (public signer keys only), reads `escrow()`, `threshold()`,
  `signer_count()` and `policy()` back and fails on any mismatch, confirms the
  on-chain WASM hash, and records the account id, WASM hash and config hash in
  `releaser-account-deployments.json`. Refuses mainnet; `--dry-run` targets a
  local quickstart. Format documented in
  `docs/releaser-account-deployment.md`; tests in
  `scripts/releaser-account-config.test.mjs`.
