Issue #474 (Phase E7): pinned the exact authorization trees for the six
lifecycle-amendment entry points — `cancel`, `top_up`, `transfer_payee`,
`extend_refund_after`, `rotate_releaser` and `rotate_releaser_with_approvals`.
Adds `assert_auth_trees` to `tests/common/auth.rs` for multi-signer calls
(order-independent) without changing `assert_auth_tree` or its callers. New
tests assert each happy-path tree (including `top_up`'s nested token
`transfer`), a wrong-signer case, and one missing-signer case per required
party; quorum rotation pins a 2-of-3 tree plus the one-approver-short
`ThresholdNotMet` case. Tests only: nothing under `contracts/escrow/src/`
changed.
