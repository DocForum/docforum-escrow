Issue #472 (Phase E6): the Python SDK can now create and settle M-of-N
releaser quorums. `create_escrow_with_releasers` mirrors the contract's
`check_releaser_set` client-side (1–10 distinct releasers, threshold in range,
never the contract's own address). `release_with_approvals` /
`refund_with_approvals` take `Keypair` approvers, reject empty, duplicate,
under-threshold and non-member lists before sending, and sign one bounded
Soroban auth entry per approver. The entry-signing loop fails closed: an
address-credential entry with no supplied key raises
`UnsupportedAuthorizationError` before the envelope is signed. An approver
that is also the envelope signer is rewritten to source-account credentials,
so no key signs twice. Package minor bump to 0.3.0; no contract change.
