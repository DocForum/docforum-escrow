---
file: ROADMAP.md
section: Phase E7 — Verification, testing & release engineering
---
- [x] **Manual testnet deployment workflow (issue #90)** —
  `.github/workflows/testnet-deploy.yml` deploys a selected ref through
  `scripts/deploy` using the `TESTNET_DEPLOY_SOURCE_SECRET` secret in the
  protected `testnet-deployer` environment, prevents concurrent deployments,
  and opens a PR containing the generated deployment records. Testnet only.
