---
"@docforum/escrow-sdk": minor
---

Add optional sponsored-funding `refund_to` (issue #28, `docs/adr/0009`).
`createEscrow` and `createQuorumEscrow` accept `refundTo?: string` (defaults to
the payer) and `getEscrow()` returns `refundTo`. Every refund path — releaser,
approvals and timeout — pays `refundTo`, which is fixed at creation under the
payer's signature.

Breaking: the generated `create_escrow*` bindings gain a trailing `refund_to`
argument and `EscrowData` gains `refund_to`. Requires a contract deployment that
includes it; the live testnet deployment predates it.
