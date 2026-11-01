Added contract tests for the five mutants the nightly mutation run missed: the
`create_escrows` batch limit, a pooled `condition_ref` of exactly 64 bytes, no
fee transfer when the fee is zero, and `settle_many` at exactly `release_time`.
Tests only, so no contract change.
