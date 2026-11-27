Issue #326 (Phase E6): SDK support for two-party releaser rotation.
`prepareRotateReleaser` checks client-side that the escrow is `Funded`,
single-releaser, and that the new releaser is not the payee, the contract or
the current releaser, then simulates `rotate_releaser` and returns the
serialized transaction, the auth entries still to sign and their expiration
ledger. `signRotationAuth` signs only the caller's own entry after checking it
covers a single `rotate_releaser` invocation on this contract with no
sub-invocations. `submitRotation` merges independently signed copies, rejects
expired (`AuthorizationExpiredError`) or incomplete authorizations before
sending, and submits from an account that holds neither party's key. When the
payer is also the releaser only one entry is needed. No contract change, so
the generated bindings are unchanged.
