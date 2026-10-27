Issue #94 (Phase E4): added `docs/runbooks/releaser-compromise.md`
(detection signals, decision tree, roles, race-to-settle steps), linked from
threat model T1, and `scripts/settle-outcomes.py`. The script validates the
integrator's outcome file, never chooses an outcome, runs the operator's own
submit command per escrow, and records each successful transaction hash in a
JSON-lines state file (`<outcomes>.state.jsonl`, rewritten atomically) so a
re-run after a crash, rate limit or fee spike skips settled escrows and
retries the rest. Stdlib only, Python 3.9+, with offline tests in
`scripts/test_settle_outcomes.py` run by a new CI job. The 50+ escrow testnet
drill is still to be run and recorded in the runbook. No contract or SDK
change.
