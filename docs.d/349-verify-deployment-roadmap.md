---
file: ROADMAP.md
section: Phase E7 — Verification, testing & release engineering
---
- [x] Deployment-record cross-checks in `scripts/verify-deployment` (issue
  #349): compares the recorded `wasmHash` with the local build and on-chain
  WASM, warns on a different checkout `gitSha` or an unrecorded id, and accepts
  `--network testnet|futurenet|local` with mainnet refused.
