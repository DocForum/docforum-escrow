Issue #310 (Phase E7): extended `contracts/escrow/tests/top_up.rs` and
`contracts/escrow/tests/sponsored_refund.rs` with coverage for `top_up` on a
quorum escrow, after payee acceptance, on a `release_not_before` escrow, a
sponsor (`refund_to`) attempting a top-up (`Unauthorized`), and the refund
after a top-up returning the full new total to `refund_to`. The refund test
asserts both the `refund_to` balance and the `solvency` liability counter.
The T13 (top-up landing after a release is approved) case is named
explicitly in the acceptance test. Tests only: no contract or SDK surface
change, so no `contract-changes.d/` fragment and unchanged generated
bindings.
