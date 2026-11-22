Issue #302 (Phase E5): the custom releaser account now authorizes exactly one
`rotate_releaser` context for its configured escrow when the account is the
current releaser. Rotation consumes one per-window operation slot and still
requires the payer's separate escrow authorization; unit and integration
coverage includes rotating and settling from the replacement releaser.
