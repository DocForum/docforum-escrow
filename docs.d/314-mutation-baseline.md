---
file: ROADMAP.md
section: Phase E7 — Verification, testing & release engineering
---
- [x] **Mutation testing fails the nightly run on new survivors (issue #314)** —
  `contracts/escrow/.cargo/mutants-baseline.txt` records the mutants the project
  accepts surviving, each with a one-line reason, and
  `scripts/mutation-baseline.mjs` diffs `mutants.out/missed.txt` against it
  (`validate` before the run, `check` after it), matching on function + mutation
  instead of `file:line:col` so line shifts do not churn the file. A survivor
  outside the baseline fails the job and is named in the job summary with the
  baseline line to add; entries that no longer survive are reported for pruning.
  `mutants.toml` now examines every module under `src/`, not just `src/lib.rs`.
