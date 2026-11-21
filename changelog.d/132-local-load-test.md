Issue #132 (Phase E7): added `scripts/load/`, a local-network load harness that
funds N channel accounts and M payees from the local Friendbot, creates
thousands of escrows concurrently (one in-flight transaction per channel),
settles each escrow with its own channel as releaser, records throughput,
latency percentiles and classified failures, and re-reads every escrow so the
run fails unless each is in its expected terminal state. It refuses any
non-loopback RPC URL, so it can never be pointed at public testnet or mainnet.
Also adds the reusable `ChannelAccountPool` to the SDK (minor changeset), a
manual Stellar Quickstart workflow that publishes the report, and
`docs/performance.md`. A reference run's numbers are not recorded yet: the
authoring environment had no Docker daemon, so a local network could not be
booted; that follow-up is tracked in ROADMAP.md.
