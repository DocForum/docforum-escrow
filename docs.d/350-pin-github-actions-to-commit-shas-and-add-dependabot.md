---
file: ROADMAP.md
section: Phase E7 — Verification, testing & release engineering
---
- [x] **Pin GitHub Actions and add Dependabot (issue #350)** — every external
  workflow action uses a verified commit SHA; weekly Dependabot updates cover
  GitHub Actions, npm, Cargo and Go modules; CI rejects floating or
  uncommented action references. The CI, release and nightly soak workflow
  permissions were narrowed to the scopes each job needs.
