---
file: ROADMAP.md
section: Phase E7 — Verification, testing & release engineering
---
- [x] Indexer dependency pinning, tests and CI (issue #347): `indexer` pins
  exact `@subql/*` versions (including the runner versions in `project.ts`) and
  commits `package-lock.json`; `subql codegen` output is generated, not
  committed; vitest covers the mapping; and a CI `indexer` job runs codegen +
  build + tests only when `indexer/**` changes.
