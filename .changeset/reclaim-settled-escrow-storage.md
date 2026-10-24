---
"@docforum/escrow-sdk": minor
---

Settled escrows are now reclaimed on-chain (issue #48, `docs/adr/0012`): after a
release, refund or cancel the contract keeps only a status tombstone and the
`ESCROW` state event carries the history.

Breaking: `getEscrow()` now throws for an escrow that has settled (its record no
longer exists). Use `getStatus()` for a settled id, which still returns
`Released`, `Refunded` or `Cancelled`, and the state event for history.
`getEscrow()` for a `Funded` escrow is unchanged. Requires a contract deployment
that includes this change.
