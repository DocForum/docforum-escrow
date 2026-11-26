Issue #366 (Phase E6): the browser demo can now create an escrow with the
payee-acceptance gate, show the payee a full review of `getEscrow` before
accepting, and call `accept`/`cancel` with the contract's own enablement rules
(Accept only for the payee, Cancel only for the payer, both only while
`Funded`, acceptance-configured and not yet accepted). The review panel shows
the releasers and threshold, `refundAfter`, `refundTo`, the fee and the rest of
the escrow record, with T8 notices for a payer-releaser overlap or a refund
destination other than the payer. The demo's Vite/TypeScript aliases were
updated to the SDK's current `dist/esm` layout, which they had not tracked, so
the demo build works again. No contract or SDK surface change.
