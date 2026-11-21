# Docs — 132: local-network load test

## README.md

- Repo layout gains:
  `scripts/load/  Local-network load test (create + settle at volume; see docs/performance.md)`
- Documentation table gains a row for `docs/performance.md`:
  “Local-network load test: how to run it, what it measures, correctness
  verification, and channel-account guidance.”

## ARCHITECTURE_ESSENTIALS.md

- SDK-surface block gains the `ChannelAccountPool` usage example and
  notes that it is the helper behind `scripts/load/`.
- New paragraph: `ChannelAccountPool` hands out exclusive use of funded
  source accounts to avoid sequence contention, does no network I/O, and
  the load harness built on it is local-only (never public testnet).

## docs/performance.md (new)

- Scope and local-only rule.
- Measurement definitions (throughput, latency percentiles, failure
  classes, post-run correctness verification).
- Reproduction steps for Docker Quickstart + `stellar` CLI + harness,
  and the manual workflow.
- Reference-results table (to be filled from a workflow run; no numbers
  are invented).
- Known bottlenecks and recommendations, including channel accounts for
  releasers and channel count as the concurrency knob.
- SDK `ChannelAccountPool` usage.
