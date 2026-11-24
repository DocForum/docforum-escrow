Issue #353 (Phase E7): the nightly testnet soak now covers the whole deployed
surface instead of an opt-in part of it. Quorum and cancel no longer need
`TESTNET_QUORUM_SUPPORTED`/`TESTNET_HAS_CANCEL`, and new live cases cover a
successful and a failed pooled round, a protocol-fee release, a two-op
`settleMany`, `isPaused`/`getPauseAdmin` and `transferPayee`. The new cases
reuse one funded identity set per run, so Friendbot use stays bounded. Test and
CI only: no contract or SDK API change, and the failure classifier still
separates a testnet reset from an SDK failure.
