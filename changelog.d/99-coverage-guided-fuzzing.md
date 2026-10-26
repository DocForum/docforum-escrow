Issue #99 (Phase E7): added a cargo-fuzz lifecycle target for randomized
create, release, refund and ledger-time sequences, including malicious token
mocks, with invariant checks after each operation. CI runs short pull-request
fuzzing and a longer nightly pass, and uploads crash artifacts. No contract
or SDK behavior changed.
