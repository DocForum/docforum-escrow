Issue #84 (Phase E6): SDK `topUp`, `accept` and `createEscrow({ requiresAcceptance })`;
`cancel` now takes any `EscrowSigner`. All three check preconditions client-side
first and throw `EscrowPreconditionError` (`InvalidAmount`, `NotFunded`,
`Unauthorized`, `AcceptanceNotConfigured`, `AlreadyAccepted`); pass
`checkPreconditions: false` to skip the read. New `prepareLifecycleCall` /
`signLifecycleCall` / `submitLifecycleCall` pass a call between signers as JSON.
`getEscrow` now returns `requiresAcceptance` and `acceptedAt`. No contract
change, bindings unchanged. `@docforum/escrow-sdk` 0.7.0 → 0.8.0.
`extendRefundAfter` and `refundByPayee` follow once #41 and #40 land.
