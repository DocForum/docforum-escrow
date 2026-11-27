Issue #107 follow-up: triaged every Scout 0.3.17 finding on the escrow
contract (11 Critical, 14 Medium, 3 Minor). The true positives are fixed with
checked arithmetic that returns existing `Error` variants, and payout amounts
are unchanged: new unit tests check the split-share and vesting helpers
against the direct formula and at `i128::MAX`, and a golden sweep test checks
split releases with a fee. The detectors whose remaining hits are all false
positives are excluded, with reasons in `docs/supply-chain.md`. The Scout CI
job blocks again: it fails on any finding, and also when Scout cannot compile
the crate. No ABI or `Error` code change.
