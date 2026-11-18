---
"@docforum/escrow-sdk": minor
---

Add `extendRefundAfter({ escrowId, newDeadline, payer, releaser })` (issue #41).

Moves a `Funded`, single-releaser escrow's `refund_after` later with the
payer's and releaser's consent. Both parties must authorize the call; either
may be given as any `EscrowSigner` (a local `Keypair` or a SEP-43 wallet
signer). The contract rejects a missing deadline, an already-elapsed
deadline, or a proposed deadline that is not strictly later, and emits
`refund_deadline_extended` on success. Bindings regenerated for the new
`extend_refund_after` contract method.

Additive surface; existing calls are unchanged.
