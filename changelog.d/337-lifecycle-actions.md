Issue #337: `useEscrowActions` gained `accept`, `cancel` and
`topUp(escrowId, amount)`. All three sign with the hook's signer (payee for
accept, payer for cancel/top-up), invalidate the escrow's `escrowKeys.detail`
query on success, and resolve a wallet rejection as `{ status: "rejected" }`.
A client-side `EscrowPreconditionError` now resolves as a typed
`{ status: "precondition", error }` result instead of rejecting, so callers can
branch on its `code`. `EscrowClientLike` was widened for the new methods.
