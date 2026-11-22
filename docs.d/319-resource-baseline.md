---
file: ROADMAP.md
section: Phase E7 — Verification, testing & release engineering
---
- [x] **Measured resource regression check (issue #319)** — CI profiles every
  function in the resource baseline with `cargo bench --bench resource_profile`,
  which emits JSON and fails when two runs of the same measurement disagree, and
  `scripts/check-resource-baseline.py` fails on measured `cpu_instructions` or
  `memory_bytes` regressions past `threshold_percent`. The old source-size
  heuristic is gone. The baseline moves only through
  `scripts/update-resource-baseline.py --note "<why>"`, reviewed in the PR.
  No contract or SDK surface change.
