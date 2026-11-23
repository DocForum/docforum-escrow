Issue #354 (Phase E7): `scripts/settle-outcomes.py` now finishes cleanly when
part of the approved outcome was already settled by someone else. New optional
`--status-cmd` reads each escrow's status before submitting and skips escrows
that are no longer `Funded`; `NotFunded` (`Error(Contract, #4)`) submissions are
recorded as settled elsewhere rather than retried. The final report separates
escrows settled as approved, settled the other way (listed as an `INCIDENT:`
signal) and still failed, and a run with only external settlements exits 0. The
runbook documents the status command, the new state records and the report. The
tool still never chooses an outcome itself.
