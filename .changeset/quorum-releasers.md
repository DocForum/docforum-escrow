---
"@docforum/escrow-sdk": minor
---

Add M-of-N releaser escrows (issue #119, `docs/adr/0007`) and adopt the
contract's new `EscrowData` shape (issue #118 / #119): `getEscrow()` now returns
`releasers: string[]` and `threshold: number` instead of `releaser: string`.

New surface:

- `createQuorumEscrow({ ..., releasers, threshold, refundAfter })`
- `releaseWithApprovals({ escrowId, approvers })`
- `refundWithApprovals({ escrowId, approvers })`
- `MAX_RELEASERS` (10) alongside the existing `MAX_CONDITION_REF_LENGTH`

Breaking for anyone reading `escrow.releaser`; use `escrow.releasers` (a plain
single-releaser escrow has exactly one entry) and `escrow.threshold`. Requires a
contract deployment that includes `create_escrow_with_releasers` — the live
testnet deployment predates it (see `docs/testnet-deployments.md`).
