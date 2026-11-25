---
file: ROADMAP.md
section: Phase E7 — Verification, testing & release engineering
---
- [x] **Pin GitHub Actions and add Dependabot (issue #350)** — every external
  workflow action uses a verified commit SHA; Dependabot keeps the pins
  current (one grouped PR a week); CI rejects floating or uncommented action
  references and prints how to look up the right SHA. The CI, release and
  nightly soak workflow permissions were narrowed to the scopes each job
  needs.
