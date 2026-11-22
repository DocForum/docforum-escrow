---
file: ROADMAP.md
section: Phase E7 — Verification, testing & release engineering
---
- [x] **Contract interface snapshot and breaking ABI guard** (issue #96) — committed `contract-spec.json` snapshot of public functions, signatures, and error codes; CI diff ensures no unreviewed interface drift; error codes are checked append-only (never renumbered or reused); interface changes are classified as additive or breaking, requiring semver bump notes.
