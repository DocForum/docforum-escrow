# 132 — Local-network load test: high-volume create and settle

## Added

- `scripts/load/` — a local-only load harness that:
  - funds N channel accounts and M payees from the local Friendbot;
  - creates `--escrows` escrows concurrently, one in-flight transaction
    per channel (`ChannelAccountPool`);
  - settles each escrow with its own channel as the releaser (release or
    refund, per `--refund-share`);
  - records throughput, per-operation latency (min/p50/p90/p99/max) and
    classified failures;
  - re-reads **every** created escrow and fails the run unless each is in
    the expected terminal state, and rejects duplicate escrow ids;
  - writes `load-report.json` + `load-report.md` under
    `scripts/load/out/` (git-ignored).
- `ChannelAccountPool` in `@docforum/escrow-sdk` (additive, `0.4.0`):
  exclusive checkout of funded source accounts so concurrent submissions
  do not reuse a sequence number. `acquire()`/`release()`/`run()` plus
  `failFast`, FIFO waiters and `close()`; 8 offline tests.
- `.github/workflows/load-test.yml` — manual (`workflow_dispatch`)
  workflow that boots Stellar Quickstart locally, deploys the contract
  with an empty allowlist, runs the harness and publishes the report as
  an artifact and in the job summary.
- `docs/performance.md` — what is measured, how to reproduce, known
  bottlenecks, correctness verification and recommendations (channel
  accounts for releasers; channel count is the concurrency ceiling).

## Safety

The harness refuses any non-loopback RPC URL, so it cannot be pointed at
public testnet or mainnet even by mistake. It creates no files outside
`scripts/load/out/` and installs nothing globally.

## Not done

A reference run's numbers are not recorded in `docs/performance.md` yet:
this change was authored in an environment without a Docker daemon, so a
local network could not be booted. The manual workflow produces the
report; the follow-up is tracked in `ROADMAP.md`.
